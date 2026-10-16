'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Git } = require('node-git-server');
const { SERVE_DIR, loadConfig, saveConfig, loadRegistry, saveRegistry } = require('./config');
const registry = require('./registry');
const { addRemote, authedUrl } = require('./peer');
const { checkPeerName, checkPeerUrl } = require('./names');
const staticFiles = require('./static');
const { BodyError, readBody, isJson, refuse, clientGone } = require('./http-body');

// Sent on every response of this public (tunneled) origin. The connect page is
// never framed and posts no form; it loads no fonts or images.
const CONNECT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// The smart-HTTP routes node-git-server answers, for a single-segment repo name.
const GIT_ROUTE_RE = /^\/[^/]+\.git\/(?:info\/refs|git-upload-pack|HEAD)$/;
const INFO_REFS_RE = /^\/([^/]+\.git)\/info\/refs$/;

// A git-protocol pkt-line: four hex digits of length (itself included), then the text.
const pktLine = (s) => (4 + Buffer.byteLength(s)).toString(16).padStart(4, '0') + s;

/** One log line for a failure on a git request; a 500 when nothing was sent yet, otherwise the response is cut off. */
function failGitResponse(res, what, err) {
  console.error(`Git server: ${what}: ${err && err.message}`);
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('git failed on the server\n');
  } else {
    res.destroy();
  }
}

/**
 * The upload-pack ref advertisement (`GET /<repo>.git/info/refs?service=git-upload-pack`), byte for byte as
 * node-git-server sends it, except that nothing is written until git-upload-pack has produced output. node-git-server
 * writes its 200 first, so a git-upload-pack that could not start, or found no repository, reached the client as an
 * empty advertisement; here either is a 500.
 */
function serveAdvertisement(repoDir, res) {
  const child = spawn('git-upload-pack', ['--stateless-rpc', '--advertise-refs', repoDir], { stdio: ['ignore', 'pipe', 'ignore'] });
  let started = false;
  let failed = false;
  const fail = (what, e) => {
    if (failed) return;
    failed = true;
    failGitResponse(res, what, e);
  };
  const start = () => {
    started = true;
    res.writeHead(200, {
      'Content-Type': 'application/x-git-upload-pack-advertisement',
      'Expires': 'Fri, 01 Jan 1980 00:00:00 GMT',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    });
    res.write(pktLine('# service=git-upload-pack\n') + '0000');
  };
  child.on('error', (e) => fail('git-upload-pack --advertise-refs did not start', e));
  child.stdout.once('data', (first) => {
    start();
    res.write(first);
    child.stdout.pipe(res);
  });
  child.on('close', (code) => {
    if (started || failed) return;
    if (code === 0) {
      start();
      res.end();
    } else {
      fail('git-upload-pack --advertise-refs failed', new Error(`exit status ${code} for ${repoDir}`));
    }
  });
  res.on('close', () => { if (child.exitCode === null) child.kill(); });
}

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

// A client that aborts mid-request makes req (or res) emit 'error'.
// node-git-server forwards req's errors to a per-request object that has no
// 'error' listener, which would throw and end the process. Errors on these two
// client streams still reach their listeners; a listener that rethrows is
// caught here, and the response is closed. An errored stream never ends its
// pipe, and node-git-server pipes req into git-upload-pack's stdin, so 'end'
// is emitted on req too: the child reads EOF and exits instead of waiting forever.
function absorbClientErrors(req, res) {
  let absorbed = false;
  for (const stream of [req, res]) {
    const emit = stream.emit;
    stream.emit = function (name, ...args) {
      if (name !== 'error') return emit.call(this, name, ...args);
      try { emit.call(this, name, ...args); } catch { /* an unlistened forward of the same error */ }
      if (!absorbed) {
        absorbed = true;
        console.error(`Git server: client connection error on ${req.method} ${staticFiles.pathOf(req.url)}: ${args[0] && args[0].message}`);
        if (!req.complete) req.emit('end');
        res.destroy();
      }
      return true;
    };
  }
}

// Control endpoint: peer registers itself with us
async function handleRegister(req, res) {
  // Real peers are Node clients, which send neither Origin nor Sec-Fetch-Site. A
  // browser sends them, and may attach a Basic credential it cached for this
  // origin, so a page elsewhere could otherwise register a peer here. Every
  // code-share version sends application/json, which a simple cross-site
  // request cannot.
  const site = req.headers['sec-fetch-site'];
  if (req.headers.origin !== undefined || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
    refuse(req, res, 403, 'Cross-site requests are not accepted');
    return;
  }
  if (!isJson(req)) { refuse(req, res, 415, 'Content-Type must be application/json'); return; }
  let text;
  try {
    text = await readBody(req);
  } catch (e) {
    if (e instanceof BodyError) { refuse(req, res, e.status, e.message); return; }
    if (clientGone(req, res, e)) return; // already logged once by absorbClientErrors
    throw e;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    sendJSON(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { url: peerUrl, token: peerToken, name: peerName, projectLeaders, projectRoles } = body;
  if (!peerUrl || !peerToken || !peerName) {
    sendJSON(res, 400, { error: 'Missing required fields: url, token, name' });
    return;
  }

  // The name becomes a git remote name and the URL a git remote URL on every
  // shared project, so both are checked before anything is written. A malformed
  // URL would also make authedUrl() throw per project, silently skipping every
  // project while the register still returned 200 { ok: true }.
  try {
    checkPeerName(peerName);
    checkPeerUrl(peerUrl);
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
    return;
  }

  // projectLeaders: { [projName]: boolean }
  // Accept old projectRoles for backward compat (string 'leader' → true, else → false).
  const leaders = projectLeaders
    || Object.fromEntries(Object.entries(projectRoles || {}).map(([k, v]) => [k, v === 'leader']));

  const reg = loadRegistry();

  // Add peer to all shared projects with per-project leader boolean. Wire the
  // git remote first and only record the peer entry once it exists, so a
  // broken/stale project (e.g. its dir is gone or not a git repo) is logged
  // and skipped instead of claiming a remote that isn't there.
  for (const proj of reg) {
    try {
      await addRemote(proj.path, peerName, authedUrl(peerUrl.replace(/\/?$/, '') + '/' + proj.name + '.git', peerToken));
    } catch (e) {
      // NOTE: console.error is deliberate — on a server whose stdio is an
      // orphaned socketpair (dead parent), Node's Console drops the bytes on
      // EPIPE (ignoreErrors default). Do NOT "improve" this to a raw
      // process.stderr.write(...): that would raise EPIPE unhandled and crash.
      console.error(`Failed to wire remote '${peerName}' on ${proj.name}: ${e.message}`);
      continue;
    }
    const peerEntry = { name: peerName, url: peerUrl, token: peerToken, leader: leaders[proj.name] ?? false };
    const existing = proj.peers.findIndex(p => p.name === peerName);
    if (existing >= 0) proj.peers[existing] = peerEntry;
    else proj.peers.push(peerEntry);
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
    url: cfg2.tunnelUrl || cfg2.selfUrl,
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

async function startServer(port, token, host = '0.0.0.0') {
  const git = new Git(SERVE_DIR, { autoCreate: false });

  // node-git-server emits a failure to start git (a missing binary, EMFILE, EAGAIN) as 'error' on the request's
  // service object, or on this instance; unlistened, either would end the process. A service object also
  // re-emits its request's errors: a client hanging up is already logged by absorbClientErrors.
  git.on('error', (e) => console.error(`Git server: ${e.message}`));
  const onServiceError = (service, what) => (e) => {
    if (clientGone(service.req, service.res, e)) return;
    failGitResponse(service.res, what, e);
  };

  git.on('push', (push) => {
    push.on('error', onServiceError(push, 'push failed'));
    push.reject(403, 'This server is read-only — pushing is not allowed');
  });

  git.on('fetch', (fetch) => {
    fetch.on('error', onServiceError(fetch, 'git-upload-pack failed'));
    fetch.accept();
  });

  const server = http.createServer(async (req, res) => {
    // node-git-server's own writeHead merges these, so git responses carry them too.
    res.setHeader('Content-Security-Policy', CONNECT_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    absorbClientErrors(req, res);
    try {
      await handleRequest(req, res);
    } catch (e) {
      console.error(`Git server request failed: ${req.method} ${staticFiles.pathOf(req.url)}:`, e);
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error\n');
    }
  });

  // A malformed request never reaches the handler; answer 400 and close.
  server.on('clientError', (err, socket) => {
    if (socket.writable && !socket._httpMessage) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  async function handleRequest(req, res) {

    // Public connect landing page and the files it loads — deliberately
    // unauthenticated: the token lives only in the URL fragment (never sent to
    // the server), so a phone scanning the QR has no credentials to offer here.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const r = staticFiles.serveConnect(staticFiles.pathOf(req.url));
      if (r) { staticFiles.send(req, res, r); return; }
    }

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

    // Route git requests via git.handle(). A repo URL is /<name>.git/…, one
    // segment naming a served link in SERVE_DIR; node-git-server would also
    // accept a deeper path, reaching a nested repo inside a shared project.
    if (!GIT_ROUTE_RE.test(staticFiles.pathOf(req.url))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found\n');
      return;
    }
    const info = req.method === 'GET' && INFO_REFS_RE.exec(staticFiles.pathOf(req.url));
    if (info && new URLSearchParams(String(req.url).split('?')[1] || '').get('service') === 'git-upload-pack') {
      const repoDir = path.join(SERVE_DIR, info[1]);
      if (!fs.existsSync(repoDir)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('repository not found');
        return;
      }
      serveAdvertisement(repoDir, res);
      return;
    }
    git.handle(req, res);
  }

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, resolve);
  });

  return { server, git };
}

module.exports = { startServer, CONNECT_CSP };
