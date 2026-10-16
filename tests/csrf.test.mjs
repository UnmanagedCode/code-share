// The web UI server only changes state for a request that declares a JSON body: a page on another origin can
// send text/plain or no body without a CORS preflight, never application/json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { request, require } from './_backend.mjs';
import { store } from './_isolatedData.mjs';

const tunnelManager = require('../src/tunnel-manager');
const { startWebUI } = require('../src/webui');

const ROOT = process.env.PROJECTS_ROOT;
const repo = path.join(ROOT, 'alpha');
let stops = 0;
let ui;
let base;
before(async () => {
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  tunnelManager.stopRuntimeTunnel = () => { stops += 1; return { tunnelUrl: null }; };
  ui = await startWebUI(0);
  base = `http://127.0.0.1:${ui.address().port}`;
});
after(() => new Promise((res) => ui.close(res)));
const post = (p, headers, body) => request(`${base}${p}`, { method: 'POST', headers, body });
const share = JSON.stringify({ path: repo, name: 'alpha' });

// Invariant: a text/plain POST (a no-preflight cross-site form or fetch) is refused with a JSON 415 and changes nothing.
test('text/plain POST is refused with 415 and no side effect', async () => {
  for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await post('/api/share', { 'Content-Type': type }, share);
    assert.equal(r.status, 415, type);
    assert.deepEqual(JSON.parse(r.body), { error: 'Content-Type must be application/json' });
  }
  assert.deepEqual(store.registry, []);
});

// Invariant: a bodiless POST with no content type (tunnel stop) is refused too, before the route runs.
test('bodiless POST without a content type is refused with 415', async () => {
  const r = await post('/api/tunnel/stop', {});
  assert.equal(r.status, 415);
  assert.equal(stops, 0);
  const del = await request(`${base}/api/unshare`, { method: 'DELETE' });
  assert.equal(del.status, 415);
});

// Invariant: JSON requests still work: a bodiless JSON-typed tunnel stop, a share, with or without a charset, any case.
test('JSON POSTs still work', async () => {
  const stop = await post('/api/tunnel/stop', { 'Content-Type': 'application/json' });
  assert.equal(stop.status, 200);
  assert.equal(stops, 1);
  const r = await post('/api/share', { 'Content-Type': 'Application/JSON; charset=utf-8' }, share);
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(store.registry.map((p) => p.name), ['alpha']);
});

// Invariant: /api/mcp answers code-conductor's bridge, which sends `content-type: application/json`, and refuses
// anything else like every other route.
test('MCP still works with the content type code-conductor sends', async () => {
  const body = JSON.stringify({ tool: 'status', arguments: {}, caller: { sessionId: null, project: null } });
  const r = await post('/api/mcp', { 'content-type': 'application/json' }, body);
  assert.equal(r.status, 200);
  assert.ok('result' in JSON.parse(r.body));
  assert.equal((await post('/api/mcp', { 'content-type': 'text/plain' }, body)).status, 415);
});

// Invariant: reads are not gated.
test('GET routes need no content type', async () => {
  assert.equal((await request(`${base}/api/health`)).status, 200);
  assert.equal((await request(`${base}/api/projects`)).status, 200);
});
