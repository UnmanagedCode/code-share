'use strict';
const http = require('http');
const { Git } = require('node-git-server');
const { SERVE_DIR, loadConfig, saveConfig, loadRegistry, saveRegistry } = require('./config');
const registry = require('./registry');
const { addRemote, authedUrl } = require('./peer');

function parseBasicAuth(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  return decoded.slice(colon + 1); // everything after the first colon is the token
}

function sendJSON(res, statusCode, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Control endpoint: peer registers itself with us
async function handleRegister(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJSON(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { url: peerUrl, token: peerToken, name: peerName, projectLeaders, projectRoles } = body;
  if (!peerUrl || !peerToken || !peerName) {
    sendJSON(res, 400, { error: 'Missing required fields: url, token, name' });
    return;
  }

  // projectLeaders: { [projName]: boolean }
  // Accept old projectRoles for backward compat (string 'leader' → true, else → false).
  const leaders = projectLeaders
    || Object.fromEntries(Object.entries(projectRoles || {}).map(([k, v]) => [k, v === 'leader']));

  const reg = loadRegistry();

  // Add peer to all shared projects with per-project leader boolean
  for (const proj of reg) {
    const peerEntry = { name: peerName, url: peerUrl, token: peerToken, leader: leaders[proj.name] ?? false };
    const existing = proj.peers.findIndex(p => p.name === peerName);
    if (existing >= 0) proj.peers[existing] = peerEntry;
    else proj.peers.push(peerEntry);
    addRemote(proj.path, peerName, authedUrl(peerUrl.replace(/\/?$/, '') + '/' + proj.name + '.git', peerToken));
  }
  saveRegistry(reg);

  // Also save at instance level in config for status display
  const cfg = loadConfig();
  cfg.peers = cfg.peers || [];
  const existingCfg = cfg.peers.findIndex(p => p.name === peerName);
  const peerEntry = { name: peerName, url: peerUrl, token: peerToken };
  if (existingCfg >= 0) cfg.peers[existingCfg] = peerEntry;
  else cfg.peers.push(peerEntry);
  saveConfig(cfg);

  // Return our own info so the caller can register us as a remote
  const cfg2 = loadConfig();
  const sharedProjects = loadRegistry().map(p => p.name);
  sendJSON(res, 200, {
    ok: true,
    url: cfg2.selfUrl || cfg2.tunnelUrl,
    token: cfg2.token,
    shared: sharedProjects
  });
}

function handleStatus(req, res) {
  const cfg = loadConfig();
  const reg = loadRegistry();
  sendJSON(res, 200, {
    token: cfg.token,
    selfUrl: cfg.selfUrl,
    tunnelUrl: cfg.tunnelUrl,
    shared: reg.map(p => ({ name: p.name, path: p.path, leader: p.leader })),
    peers: cfg.peers || []
  });
}

async function startServer(port, token) {
  const git = new Git(SERVE_DIR, { autoCreate: false });

  git.on('push', (push) => {
    push.reject(403, 'This server is read-only — pushing is not allowed');
  });

  git.on('fetch', (fetch) => {
    fetch.accept();
  });

  const server = http.createServer(async (req, res) => {
    // Enforce auth on every request
    const providedToken = parseBasicAuth(req);
    if (providedToken !== token) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="code-share"',
        'Content-Type': 'text/plain'
      });
      res.end('Unauthorized: invalid or missing token\n');
      return;
    }

    // Block git-receive-pack (push) at HTTP level — read-only enforcement layer 1
    if (req.url && req.url.includes('git-receive-pack')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: this server is read-only, pushing is not allowed\n');
      return;
    }

    // Control endpoints
    if (req.method === 'POST' && req.url === '/control/register') {
      await handleRegister(req, res);
      return;
    }
    if (req.method === 'GET' && req.url === '/control/status') {
      handleStatus(req, res);
      return;
    }

    // Route git requests via git.handle()
    git.handle(req, res);
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });

  return { server, git };
}

module.exports = { startServer };
