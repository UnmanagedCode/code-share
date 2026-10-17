// `--tunnel localtunnel` on the overridden axios. This file deliberately does not import tests/_backend.mjs (which
// stubs src/tunnel.js): it loads the real src/tunnel.js, but replaces the `localtunnel` export so the client's `host`
// is always a loopback stub of the localtunnel server API. No request ever leaves the machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startTunnel } = require('../src/tunnel');

// Resolved the way src/tunnel.js resolves it, so the replaced export is the one it gets.
const tunnelReq = createRequire(require.resolve('../src/tunnel'));
const ltPath = tunnelReq.resolve('localtunnel');
const realLt = tunnelReq('localtunnel');
let stubApiUrl = null;
require.cache[ltPath].exports = (opts) => realLt({ ...opts, host: stubApiUrl });
after(() => { require.cache[ltPath].exports = realLt; });

// The floor of the `overrides.localtunnel.axios` range.
const MIN_AXIOS = '1.20.0';

async function eventually(check, ms = 5000) {
  const end = Date.now() + ms;
  let value = await check();
  while (!value && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    value = await check();
  }
  return value;
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = (server) => new Promise((resolve) => server.close(resolve));

/** Loopback stand-in for the localtunnel server (API, tunnel socket port, public port) and the local git server. */
async function startStub({ failFirst = false } = {}) {
  const live = new Set();
  const pool = [];
  const apiHits = [];

  const local = http.createServer((req, res) => res.end(`hello ${req.url}`));
  const tsrv = net.createServer((s) => {
    live.add(s);
    pool.push(s);
    s.on('error', () => {});
    s.on('close', () => {
      live.delete(s);
      const i = pool.indexOf(s);
      if (i >= 0) pool.splice(i, 1);
    });
  });
  const pub = net.createServer((c) => {
    const t = pool.shift();
    c.on('error', () => {});
    if (!t) return c.destroy();
    c.pipe(t).pipe(c);
  });
  const localPort = await listen(local);
  const tsrvPort = await listen(tsrv);
  const pubPort = await listen(pub);
  const url = `http://127.0.0.1:${pubPort}`;
  const api = http.createServer((req, res) => {
    apiHits.push(req.url);
    if (failFirst && apiHits.length === 1) { res.statusCode = 503; return res.end('unavailable'); }
    if (req.url !== '/?new') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 't1', ip: '127.0.0.1', port: tsrvPort, max_conn_count: 2, url }));
  });
  const apiPort = await listen(api);
  stubApiUrl = `http://127.0.0.1:${apiPort}`;

  return {
    live, apiHits, localPort, url,
    async close() {
      for (const s of live) s.destroy();
      await Promise.all([local, tsrv, pub, api].map(closeServer));
    },
  };
}

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, { agent: false }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

const parts = (v) => v.split('.').map(Number);
const atLeast = (v, min) => {
  const [a, b] = [parts(v), parts(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

// Invariant: package.json overrides localtunnel's axios to a range whose floor is MIN_AXIOS, and the axios localtunnel
// actually resolves is a 1.x at or above that floor (the 0.x line carries the advisories the override exists to avoid).
test('localtunnel resolves the overridden axios', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.overrides?.localtunnel?.axios, `^${MIN_AXIOS}`, 'package.json overrides.localtunnel.axios');
  const { version } = JSON.parse(readFileSync(createRequire(ltPath).resolve('axios/package.json'), 'utf8'));
  assert.ok(parts(version)[0] >= 1, `localtunnel resolves axios ${version}, below 1.x`);
  assert.ok(atLeast(version, MIN_AXIOS), `localtunnel resolves axios ${version}, below ${MIN_AXIOS}`);
});

// Invariant: through the real src/tunnel.js, a localtunnel tunnel resolves to the url its server assigned, relays an
// HTTP request to the local port, and after stop() holds no socket and does not re-dial.
test('a localtunnel tunnel opens, carries a request, and closes', async () => {
  const stub = await startStub();
  let tunnel;
  try {
    assert.notEqual(tunnelReq('localtunnel'), realLt, 'localtunnel export is not replaced');
    tunnel = await startTunnel('localtunnel', stub.localPort);
    assert.equal(tunnel.url, stub.url);
    assert.deepEqual(stub.apiHits, ['/?new']);
    assert.ok(await eventually(() => stub.live.size === 2), `tunnel sockets: ${stub.live.size}`);
    const res = await get(`${stub.url}/probe`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'hello /probe');
    await tunnel.stop();
    tunnel = null;
    assert.ok(await eventually(() => stub.live.size === 0), `tunnel sockets after stop: ${stub.live.size}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stub.live.size, 0, 'tunnel re-dialled after stop');
  } finally {
    if (tunnel) await tunnel.stop();
    await stub.close();
  }
});

// Invariant: a localtunnel server error (non-2xx) is retried by localtunnel, not surfaced as a failed start.
test('a localtunnel server error is retried, not fatal', async () => {
  const stub = await startStub({ failFirst: true });
  let tunnel;
  try {
    assert.notEqual(tunnelReq('localtunnel'), realLt, 'localtunnel export is not replaced');
    tunnel = await startTunnel('localtunnel', stub.localPort);
    assert.equal(tunnel.url, stub.url);
    assert.deepEqual(stub.apiHits, ['/?new', '/?new']);
    await tunnel.stop();
    tunnel = null;
    assert.ok(await eventually(() => stub.live.size === 0), `tunnel sockets after stop: ${stub.live.size}`);
  } finally {
    if (tunnel) await tunnel.stop();
    await stub.close();
  }
});
