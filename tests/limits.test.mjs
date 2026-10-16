// A peer that stalls or floods, or a client that sends too much, can never freeze or exhaust the servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { request, require } from './_backend.mjs';
import { store } from './_isolatedData.mjs';

const { LIMITS } = require('../src/limits');
const { startWebUI } = require('../src/webui');
const { startServer } = require('../src/server');

const ROOT = process.env.PROJECTS_ROOT;
const DEFAULTS = { ...LIMITS };
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const close = (server) => new Promise((res) => server.close(() => res()));

// A peer that accepts connections and never says a word.
const sockets = new Set();
const silent = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
let silentPort;
// A peer that answers /control/register, stalls /control/status, and floods /flood/control/status.
const halfPeer = http.createServer((req, res) => {
  if (req.url === '/control/register') {
    req.resume();
    req.on('end', () => res.end(JSON.stringify({ ok: true, url: 'http://10.0.0.9:1', token: 'p', shared: [] })));
  } else if (req.url === '/flood/control/status') {
    res.end('x'.repeat(64 * 1024));
  }
  // anything else: never answered
});
let halfPort;
let ui;
let base;
let git;

before(async () => {
  silentPort = await listen(silent);
  halfPort = await listen(halfPeer);
  ({ server: git } = await startServer(0, 'tok', '127.0.0.1'));
  ui = await startWebUI(0);
  base = `http://127.0.0.1:${ui.address().port}`;
  const repo = path.join(ROOT, 'p');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  store.registry = [{ name: 'p', path: repo, leader: false, peers: [] }];
  store.config = {
    ...store.config,
    port: git.address().port,
    selfUrl: `http://x:tok@127.0.0.1:${git.address().port}`,
    peers: [
      { name: 'stalled', url: `http://127.0.0.1:${silentPort}`, token: 't' },
      { name: 'flood', url: `http://127.0.0.1:${halfPort}/flood`, token: 't' },
    ],
  };
});
after(async () => {
  Object.assign(LIMITS, DEFAULTS);
  for (const s of sockets) s.destroy();
  halfPeer.closeAllConnections();
  await Promise.all([close(ui), close(git), close(silent), close(halfPeer)]);
});

/** Asks /api/health (and /connect on the git server) while `pending` is in flight; returns the slowest answer in ms. */
async function staysResponsive(pending) {
  let slowest = 0;
  let done = false;
  pending.finally(() => { done = true; });
  for (let i = 0; i < 5 && !done; i++) {
    const t = Date.now();
    assert.equal((await request(`${base}/api/health`)).status, 200);
    assert.equal((await request(`http://127.0.0.1:${git.address().port}/connect`)).status !== 0, true);
    slowest = Math.max(slowest, Date.now() - t);
    await new Promise((r) => setTimeout(r, 100));
  }
  return slowest;
}

// Invariant: a git fetch from a peer that never answers does not block the event loop (health and the git server
// keep answering) and is killed at LIMITS.GIT_TIMEOUT_MS with a clear "timed out" error.
test('sync-status against a stalled peer: servers stay up, then a timeout error', async () => {
  LIMITS.GIT_TIMEOUT_MS = 3000;
  try {
    const t = Date.now();
    const pending = request(`${base}/api/sync-status?project=p&remote=stalled`);
    const slowest = await staysResponsive(pending);
    assert.ok(slowest < 1000, `health answered in ${slowest}ms during a 3s fetch`);
    const r = await pending;
    assert.equal(r.status, 500);
    assert.match(JSON.parse(r.body).error, /git fetch failed: git fetch timed out after \d+s/);
    assert.ok(Date.now() - t < 8000, 'bounded by the deadline');
  } finally {
    LIMITS.GIT_TIMEOUT_MS = DEFAULTS.GIT_TIMEOUT_MS;
  }
});

// Invariant: a peer HTTP call is bounded by LIMITS.PEER_HTTP_TIMEOUT_MS, and the UI stays responsive meanwhile.
test('peer-status against a stalled peer: a 502 naming the timeout', async () => {
  LIMITS.PEER_HTTP_TIMEOUT_MS = 800;
  try {
    const pending = request(`${base}/api/peer-status?peer=stalled`);
    assert.ok((await staysResponsive(pending)) < 1000);
    const r = await pending;
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.body).error, /^Could not reach peer: Peer did not answer within \d+s/);
  } finally {
    LIMITS.PEER_HTTP_TIMEOUT_MS = DEFAULTS.PEER_HTTP_TIMEOUT_MS;
  }
});

// Invariant: a peer reply larger than LIMITS.PEER_RESPONSE_MAX_BYTES is cut off and reported, never buffered whole.
test('peer-status against a flooding peer: refused as too large', async () => {
  LIMITS.PEER_RESPONSE_MAX_BYTES = 1000;
  try {
    const r = await request(`${base}/api/peer-status?peer=flood`);
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.body).error, /Peer reply larger than 1000 bytes/);
  } finally {
    LIMITS.PEER_RESPONSE_MAX_BYTES = DEFAULTS.PEER_RESPONSE_MAX_BYTES;
  }
});

// Invariant: connect returns even when the peer accepts the handshake but stalls its status: the status call is
// bounded and its failure is tolerated, so the peer is stored.
test('connect: a peer that stalls /control/status does not hang the request', async () => {
  LIMITS.PEER_HTTP_TIMEOUT_MS = 800;
  try {
    const t = Date.now();
    const r = await request(`${base}/api/connect`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ url: `http://127.0.0.1:${halfPort}`, token: 'p', name: 'half' }) });
    assert.equal(r.status, 200, r.body);
    assert.ok(Date.now() - t < 5000);
    assert.ok(store.config.peers.some((p) => p.name === 'half'));
  } finally {
    LIMITS.PEER_HTTP_TIMEOUT_MS = DEFAULTS.PEER_HTTP_TIMEOUT_MS;
  }
});

/** POSTs `size` bytes to `port` `path` (declared or chunked); resolves the status, or the client-side error. */
function bigPost(port, urlPath, { size, declared, headers = {} }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': size } : {}), ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (e) => resolve(`client error: ${e.code}`));
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        sent += chunk.length;
        if (!req.write(chunk)) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}

// Invariant: a body over LIMITS.REQUEST_BODY_MAX_BYTES is refused with 413, whether declared or streamed, on both
// servers, and both keep serving.
test('oversized request bodies get 413 and the servers survive', async () => {
  LIMITS.REQUEST_BODY_MAX_BYTES = 256 * 1024;
  const auth = { authorization: `Basic ${Buffer.from('x:tok').toString('base64')}` };
  try {
    const uiPort = ui.address().port;
    assert.equal(await bigPost(uiPort, '/api/mcp', { size: 4 * 1024 * 1024, declared: true }), 413);
    assert.equal(await bigPost(uiPort, '/api/mcp', { size: 4 * 1024 * 1024, declared: false }), 413);
    assert.equal(await bigPost(git.address().port, '/control/register', { size: 4 * 1024 * 1024, declared: true, headers: auth }), 413);
    assert.equal(await bigPost(git.address().port, '/control/register', { size: 4 * 1024 * 1024, declared: false, headers: auth }), 413);
    assert.equal((await request(`${base}/api/health`)).status, 200);
    assert.equal((await request(`http://127.0.0.1:${git.address().port}/connect`)).status !== 0, true);
    const ok = await request(`${base}/api/mcp`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ tool: 'status', arguments: {} }) });
    assert.equal(ok.status, 200);
  } finally {
    LIMITS.REQUEST_BODY_MAX_BYTES = DEFAULTS.REQUEST_BODY_MAX_BYTES;
  }
});

// Invariant: a client hanging up in the middle of a web UI request body is not an error: nothing is logged.
test('an aborted web UI body logs no stack', async () => {
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' '));
  try {
    await new Promise((resolve) => {
      const s = net.connect(ui.address().port, '127.0.0.1', () => {
        s.write('POST /api/share HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"path":');
        setTimeout(() => { s.resetAndDestroy(); resolve(); }, 200);
      });
      s.on('error', () => {});
    });
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    console.error = error;
  }
  assert.deepEqual(logged, []);
  assert.equal((await request(`${base}/api/health`)).status, 200);
});
