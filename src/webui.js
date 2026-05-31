'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, loadRegistry, PROJECTS_ROOT } = require('./config');
const registry = require('./registry');
const peer = require('./peer');

const UI_HTML = path.join(__dirname, '../static/ui.html');

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
      sendJSON(res, 200, { ok: true, entry });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
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
        name: body.name || 'peer',
        role: body.role || null
      });
      sendJSON(res, 200, { ok: true, result });
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
