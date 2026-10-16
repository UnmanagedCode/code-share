// /control/register refuses browser-shaped requests (a page elsewhere riding a cached Basic credential) and
// keeps accepting every code-share peer, whose client is a Node http request with a JSON body.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { request, require } from './_backend.mjs';
import { store } from './_isolatedData.mjs';

const { startServer } = require('../src/server');
const AUTH = `Basic ${Buffer.from('x:tok').toString('base64')}`;
let server;
let base;
before(async () => {
  ({ server } = await startServer(0, 'tok', '127.0.0.1'));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((res) => server.close(res)));

const body = (name) => JSON.stringify({ url: 'http://10.0.0.7:9419', token: 'peer-token', name, projectLeaders: {} });
const register = (headers, name) => request(`${base}/control/register`, { method: 'POST', headers: { authorization: AUTH, ...headers }, body: body(name) });
const peerNames = () => store.config.peers.map((p) => p.name);

// Invariant: a request carrying Origin, or a Sec-Fetch-Site other than same-origin/none, is refused with a JSON 403
// before its body is read, and records no peer, whatever its content type.
test('browser-shaped register requests are refused', async () => {
  const cases = [
    { origin: 'https://evil.example', 'content-type': 'text/plain' },
    { origin: 'https://evil.example', 'content-type': 'application/json' },
    { origin: 'null', 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'same-site', 'content-type': 'application/json' },
  ];
  for (const headers of cases) {
    const r = await register(headers, 'evil');
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.deepEqual(JSON.parse(r.body), { error: 'Cross-site requests are not accepted' });
  }
  assert.deepEqual(peerNames(), []);
});

// Invariant: without a JSON content type a register request is refused with 415 (a simple cross-site request
// cannot send one), and records no peer.
test('a non-JSON register is refused with 415', async () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
    const r = await register(type ? { 'content-type': type } : {}, 'plain');
    assert.equal(r.status, 415, String(type));
  }
  assert.deepEqual(peerNames(), []);
});

// Invariant: the gate does not run before auth: an unauthenticated browser request is still a 401.
test('auth still comes first', async () => {
  const r = await request(`${base}/control/register`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: body('x') });
  assert.equal(r.status, 401);
});

// postJSON exactly as the master branch's src/peer.js sends /control/register (every released code-share peer).
function postJSON(url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Basic ${Buffer.from(`x:${token}`).toString('base64')}`
      }
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.trim()}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}


// Invariant: a register request byte-for-byte as released code-share peers send it still registers.
test('a peer using the released client still registers', async () => {
  const reply = await postJSON(`${base}/control/register`, { url: 'http://10.0.0.7:9419', token: 'peer-token', name: 'oldpeer', projectLeaders: {} }, 'tok');
  assert.equal(reply.ok, true);
  assert.deepEqual(peerNames(), ['oldpeer']);
});

// Invariant: a same-origin or user-initiated (Sec-Fetch-Site none) JSON request is not treated as cross-site.
test('Sec-Fetch-Site same-origin or none is accepted', async () => {
  for (const [site, name] of [['same-origin', 'same'], ['none', 'direct']]) {
    const r = await register({ 'sec-fetch-site': site, 'content-type': 'application/json' }, name);
    assert.equal(r.status, 200, r.body);
  }
  assert.deepEqual(peerNames(), ['oldpeer', 'same', 'direct']);
});
