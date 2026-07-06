'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, loadRegistry, PROJECTS_ROOT } = require('./config');
const registry = require('./registry');
const peer = require('./peer');
const { getSyncState } = require('./sync');

const UI_HTML = path.join(__dirname, '../static/ui.html');

// Authenticated GET to a peer's control endpoint
function fetchJSON(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Authorization': `Basic ${Buffer.from(`x:${token}`).toString('base64')}`
      }
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${text.trim()}`)); return; }
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleAPI(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/status') {
    const cfg = loadConfig();
    const reg = loadRegistry();
    sendJSON(res, 200, {
      token: cfg.token,
      selfUrl: cfg.selfUrl,
      tunnelUrl: cfg.tunnelUrl,
      port: cfg.port,
      uiPort: cfg.uiPort,
      tunnel: cfg.tunnel,
      projectsRoot: PROJECTS_ROOT,
      shared: reg,
      peers: cfg.peers || []
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    const projects = registry.scanProjectsRoot();
    sendJSON(res, 200, projects);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/share') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    try {
      const name = body.name || path.basename(body.path || '');
      const entry = registry.addProject(body.path, name);
      // Wire the peer git remote + registry peer entry for every connected peer,
      // mirroring the CLI `share` — otherwise a UI-shared project gets peers:[]
      // and never renders a Sync button (and has no `peer` remote to sync against).
      peer.wireConnectedPeers(name, entry.path);
      sendJSON(res, 200, { ok: true, entry });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return true;
  }

  // Clone a project from a connected peer into PROJECTS_ROOT, register it, and
  // wire the peer remote so it is immediately syncable (mirrors CLI clone + share,
  // but lands in PROJECTS_ROOT and registers, which the bare CLI clone does not).
  if (req.method === 'POST' && pathname === '/api/clone') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { peer: peerName, project } = body;
    if (!peerName || !project) {
      sendJSON(res, 400, { error: 'peer and project are required' });
      return true;
    }
    const cfg = loadConfig();
    const peerInfo = (cfg.peers || []).find(p => p.name === peerName);
    if (!peerInfo) { sendJSON(res, 404, { error: `Peer not found: ${peerName}` }); return true; }
    const dest = path.join(PROJECTS_ROOT, project);
    if (fs.existsSync(dest)) { sendJSON(res, 400, { error: `Destination already exists: ${dest}` }); return true; }
    if (registry.findProject(project)) { sendJSON(res, 400, { error: `Name already in use: ${project}` }); return true; }
    try {
      const projUrl = peerInfo.url.replace(/\/?$/, '') + '/' + project + '.git';
      peer.cloneRepo(projUrl, peerInfo.token, dest);
    } catch (e) {
      sendJSON(res, 500, { error: `Clone failed: ${e.message}` });
      return true;
    }
    try {
      const entry = registry.addProject(dest, project);
      peer.wireConnectedPeers(project, entry.path);
      sendJSON(res, 200, { ok: true, entry });
    } catch (e) {
      sendJSON(res, 500, { error: `Cloned to ${dest} but registration failed: ${e.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/unshare') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    try {
      registry.removeProject(body.name);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/connect') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    try {
      const result = await peer.connectPeer(body.url, body.token, {
        name: body.name || 'peer'
      });
      sendJSON(res, 200, { ok: true, result });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // Set per-project leader flag
  if (req.method === 'POST' && pathname === '/api/project-leader') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { name, leader } = body;
    if (!name) { sendJSON(res, 400, { error: 'name is required' }); return true; }
    if (typeof leader !== 'boolean') { sendJSON(res, 400, { error: 'leader must be a boolean' }); return true; }
    try {
      registry.updateProject(name, { leader });
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return true;
  }

  // Fetch a connected peer's /control/status (shows their shared projects)
  if (req.method === 'GET' && pathname === '/api/peer-status') {
    const peerName = url.searchParams.get('peer');
    const cfg = loadConfig();
    const peerInfo = (cfg.peers || []).find(p => p.name === peerName);
    if (!peerInfo) { sendJSON(res, 404, { error: `Peer not found: ${peerName}` }); return true; }
    try {
      const statusUrl = peerInfo.url.replace(/\/?$/, '') + '/control/status';
      const peerStatus = await fetchJSON(statusUrl, peerInfo.token);
      sendJSON(res, 200, peerStatus);
    } catch (e) {
      sendJSON(res, 502, { error: `Could not reach peer: ${e.message}` });
    }
    return true;
  }

  // Compute sync state (ahead/behind) for a shared project vs a remote
  if (req.method === 'GET' && pathname === '/api/sync-status') {
    const projectName = url.searchParams.get('project');
    const remoteName  = url.searchParams.get('remote') || 'peer';
    if (!projectName) { sendJSON(res, 400, { error: 'project query param is required' }); return true; }
    try {
      // Self-heal: if the project is local and we know this peer, make sure its
      // git remote + registry peer entry exist before checking. The Connected
      // Peers UI shows a Sync button for any project both sides share (live
      // catalog ∩ local registry), which may include projects whose peer remote
      // was never wired (e.g. shared before the wiring fix). Idempotent.
      const proj = registry.findProject(projectName);
      if (proj) {
        const pr = (loadConfig().peers || []).find(p => p.name === remoteName);
        if (pr) { try { peer.wirePeerRemote(projectName, proj.path, pr); } catch {} }
      }
      const state = getSyncState(projectName, { remote: remoteName });
      sendJSON(res, 200, state);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

async function startWebUI(uiPort) {
  const server = http.createServer(async (req, res) => {
    // JSON API
    if (req.url && req.url.startsWith('/api/')) {
      const handled = await handleAPI(req, res);
      if (handled) return;
    }

    // Serve UI
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      try {
        const html = fs.readFileSync(UI_HTML, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('UI file not found');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    // Bind to loopback only — never exposed through tunnel
    server.listen(uiPort, '127.0.0.1', resolve);
  });

  return server;
}

module.exports = { startWebUI };
