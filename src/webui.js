'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, loadRegistry, PROJECTS_ROOT } = require('./config');
const registry = require('./registry');
const peer = require('./peer');
const { sync, getSyncState } = require('./sync');
const tunnelManager = require('./tunnel-manager');
const { handleMCP } = require('./mcp');
const staticFiles = require('./static');
const { checkProjectName, checkPeerName, checkBranch, childPath } = require('./names');
const { peerRequest } = require('./peer-http');
const { BodyError, readBody, isJson, refuse, clientGone } = require('./http-body');

// Sent on every response. No 'unsafe-inline' anywhere: the UI uses no component
// that injects a <style>, and the QR code is inline SVG elements (no img-src).
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";

// The body handleRequest read up front (every non-GET/HEAD request, JSON-typed and capped).
const requestBody = async (req) => req.bodyText;

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Self-heal: if the project is local and we know this peer, make sure its git
// remote + registry peer entry exist before touching it. The Connected Peers
// UI shows a Fetch/Sync button for any project both sides share (live peer
// catalog ∩ local registry), which may include projects whose peer remote was
// never wired (e.g. shared before the wiring fix). Idempotent. Shared by both
// /api/sync-status and /api/sync so the two routes can't drift out of step.
async function selfHealPeerRemote(projectName, remoteName) {
  const proj = registry.findProject(projectName);
  if (!proj) return;
  const pr = (loadConfig().peers || []).find(p => p.name === remoteName);
  if (!pr) return;
  try { await peer.wirePeerRemote(projectName, proj.path, pr); } catch {}
}

async function handleAPI(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // Cheap, side-effect-free liveness probe (used as the plugin manifest's
  // healthPath) — deliberately separate from /api/status, which echoes the
  // plaintext instance token and shouldn't be hit by an arbitrary prober.
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJSON(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/mcp') {
    await handleMCP(req, res, requestBody, sendJSON);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const cfg = loadConfig();
    const reg = loadRegistry();
    const ts = tunnelManager.getTunnelStatus();
    sendJSON(res, 200, {
      token: cfg.token,
      selfUrl: cfg.selfUrl,
      tunnelUrl: cfg.tunnelUrl,
      port: cfg.port,
      uiPort: cfg.uiPort,
      tunnel: cfg.tunnel,
      tunnelStarting: ts.starting,
      projectsRoot: PROJECTS_ROOT,
      shared: reg,
      peers: cfg.peers || []
    });
    return true;
  }

  // Start a tunnel while serve is already running (default: cloudflared)
  if (req.method === 'POST' && pathname === '/api/tunnel/start') {
    let body;
    try { body = JSON.parse(await requestBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    try {
      const status = await tunnelManager.startRuntimeTunnel(body.type || 'cloudflared');
      sendJSON(res, 200, { ok: true, ...status });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return true;
  }

  // Stop the currently active runtime/startup tunnel, back to LAN-only
  if (req.method === 'POST' && pathname === '/api/tunnel/stop') {
    const status = tunnelManager.stopRuntimeTunnel();
    sendJSON(res, 200, { ok: true, ...status });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    const projects = registry.scanProjectsRoot();
    sendJSON(res, 200, projects);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/share') {
    let body;
    try { body = JSON.parse(await requestBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    try {
      const name = body.name || path.basename(body.path || '');
      const entry = registry.addProject(body.path, name);
      // Wire the peer git remote + registry peer entry for every connected peer,
      // mirroring the CLI `share` — otherwise a UI-shared project gets peers:[]
      // and never renders a Sync button (and has no `peer` remote to sync against).
      await peer.wireConnectedPeers(name, entry.path);
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
    try { body = JSON.parse(await requestBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { peer: peerName, project } = body;
    if (!peerName || !project) {
      sendJSON(res, 400, { error: 'peer and project are required' });
      return true;
    }
    // `project` comes from the peer's catalog: one plain path segment, landing directly inside PROJECTS_ROOT.
    let dest;
    try {
      dest = childPath(PROJECTS_ROOT, checkProjectName(project));
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
      return true;
    }
    const cfg = loadConfig();
    const peerInfo = (cfg.peers || []).find(p => p.name === peerName);
    if (!peerInfo) { sendJSON(res, 404, { error: `Peer not found: ${peerName}` }); return true; }
    if (fs.existsSync(dest)) { sendJSON(res, 400, { error: `Destination already exists: ${dest}` }); return true; }
    if (registry.findProject(project)) { sendJSON(res, 400, { error: `Name already in use: ${project}` }); return true; }
    try {
      const projUrl = peerInfo.url.replace(/\/?$/, '') + '/' + project + '.git';
      await peer.cloneRepo(projUrl, peerInfo.token, dest);
    } catch (e) {
      sendJSON(res, 500, { error: `Clone failed: ${e.message}` });
      return true;
    }
    try {
      const entry = registry.addProject(dest, project);
      await peer.wireConnectedPeers(project, entry.path);
      sendJSON(res, 200, { ok: true, entry });
    } catch (e) {
      sendJSON(res, 500, { error: `Cloned to ${dest} but registration failed: ${e.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/unshare') {
    let body;
    try { body = JSON.parse(await requestBody(req)); } catch {
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
    try { body = JSON.parse(await requestBody(req)); } catch {
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
    try { body = JSON.parse(await requestBody(req)); } catch {
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
      const peerStatus = await peerRequest(statusUrl, { token: peerInfo.token });
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
      await selfHealPeerRemote(projectName, remoteName);
      const state = await getSyncState(projectName, { remote: remoteName });
      sendJSON(res, 200, state);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // Perform a real pull-only sync (fetch + merge/rebase per src/sync.js's
  // leader-derived mode) and return the post-sync ahead/behind state, mirroring
  // the MCP bridge's `sync` tool (src/mcp.js) and the CLI `sync` command.
  if (req.method === 'POST' && pathname === '/api/sync') {
    let body;
    try { body = JSON.parse(await requestBody(req)); } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { project, remote = 'peer', branch, useRebase = false } = body;
    if (!project) { sendJSON(res, 400, { error: 'project is required' }); return true; }
    // sync() refuses these too; checking first means a bad value runs no git at all.
    try {
      checkPeerName(remote);
      if (branch) checkBranch(branch);
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
      return true;
    }
    try {
      await selfHealPeerRemote(project, remote);
      const outcome = await sync(project, { remote, branch, useRebase: !!useRebase });
      const state = await getSyncState(outcome.project, { remote });
      sendJSON(res, 200, { ok: true, ...state });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  // Every request that can change state must say it is JSON. A page on another
  // origin can POST text/plain (or nothing) here without a CORS preflight, but
  // not application/json, so this refuses cross-site requests. code-conductor's
  // MCP bridge sends application/json to /api/mcp.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!isJson(req)) { refuse(req, res, 415, 'Content-Type must be application/json'); return; }
    try {
      req.bodyText = await readBody(req);
    } catch (e) {
      if (e instanceof BodyError) { refuse(req, res, e.status, e.message); return; }
      if (clientGone(req, res, e)) return; // the client hung up mid-body: nothing to answer
      throw e;
    }
  }

  // JSON API
  if (req.url && req.url.startsWith('/api/')) {
    const handled = await handleAPI(req, res);
    if (handled) return;
  }

  // Built UI: `/` (and its `/index.html` alias) and the hashed assets. No SPA
  // fallback: anything else, the host URLs /pluginBridge.js and /pluginTheme.css
  // included, is a real 404.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const r = staticFiles.serveUi(staticFiles.pathOf(req.url));
    if (r) { staticFiles.send(req, res, r); return; }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
}

async function startWebUI(uiPort) {
  const indexHtml = staticFiles.distFile('index.html');
  if (!fs.existsSync(indexHtml)) console.error(`UI not built: ${indexHtml} is missing — run npm install`);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', UI_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await handleRequest(req, res);
    } catch (e) {
      console.error(`Web UI request failed: ${req.method} ${req.url}:`, e);
      if (res.headersSent) { res.destroy(); return; }
      if (req.url && req.url.startsWith('/api/')) {
        sendJSON(res, 500, { error: 'Internal error' });
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal error\n');
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    // Bind to loopback only — never exposed through tunnel
    server.listen(uiPort, '127.0.0.1', resolve);
  });

  return server;
}

module.exports = { startWebUI, UI_CSP };
