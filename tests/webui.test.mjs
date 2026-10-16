// The web UI server (src/webui.js) over HTTP: CSP and nosniff on every response,
// static routes, and a handler error answered with a 500 instead of a crash.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { require, request, fakeDist } from './_backend.mjs';

const { startWebUI, UI_CSP } = require('../src/webui');
const staticFiles = require('../src/static');
const registry = require('../src/registry');

const files = {
  'index.html': '<!doctype html><title>Code Share</title>',
  'theme-init.js': '/* t */',
  'assets/index-AAAA.js': 'i',
  'assets/src-DDDD.css': 'x{}',
};
let server;
let base;
before(async () => {
  staticFiles._setDistDir(fakeDist(files));
  server = await startWebUI(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  staticFiles._setDistDir(null);
  await new Promise((res) => server.close(res));
});

function assertHardened(r, what) {
  assert.equal(r.headers.get('content-security-policy'), UI_CSP, `${what}: CSP`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
}

// Invariant: the CSP is the Part 2 minimum: no 'unsafe-inline', no img-src, framing by cc only.
test('UI_CSP is the strict policy', () => {
  assert.equal(UI_CSP, "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
});

// Invariant: every kind of response carries the CSP and nosniff; the page, its alias and assets are served;
// the host URLs and unknown paths are text/plain 404s (no SPA fallback).
test('every response carries the CSP and nosniff', async () => {
  const page = await request(`${base}/`);
  assert.equal(page.status, 200);
  assert.equal(page.body, files['index.html']);
  assertHardened(page, '/');
  const alias = await request(`${base}/index.html`);
  assert.equal(alias.status, 200);
  assert.equal(alias.body, files['index.html']);
  assertHardened(alias, '/index.html');
  for (const p of ['/assets/index-AAAA.js', '/assets/src-DDDD.css', '/theme-init.js']) {
    const r = await request(base + p);
    assert.equal(r.status, 200, p);
    assertHardened(r, p);
  }
  const health = await request(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });
  assertHardened(health, '/api/health');
  for (const p of ['/pluginBridge.js', '/pluginTheme.css', '/nope', '/vendor/qrcode.js', '/api/nope']) {
    const r = await request(base + p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8', p);
    assertHardened(r, p);
  }
  const head = await request(`${base}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assertHardened(head, 'HEAD /');
});

// Invariant: with no build the server still answers: `/` is a text/plain 503 with the CSP, the API stays up.
test('/ is a hardened 503 while the UI is not built', async () => {
  staticFiles._setDistDir(path.join(fakeDist({}), 'missing'));
  try {
    const r = await request(`${base}/`);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(r.body, /UI not built — run npm install/);
    assertHardened(r, '503');
    assert.equal((await request(`${base}/api/health`)).status, 200);
  } finally {
    staticFiles._setDistDir(fakeDist(files));
  }
});

// Invariant: a throwing handler is a JSON 500 under /api/ (with the CSP), and the server keeps serving.
test('a handler error is a 500 and the server survives', async () => {
  const original = registry.scanProjectsRoot;
  const logged = [];
  const originalError = console.error;
  registry.scanProjectsRoot = () => { throw new Error('boom'); };
  console.error = (...a) => logged.push(a);
  try {
    const r = await request(`${base}/api/projects`);
    assert.equal(r.status, 500);
    assert.deepEqual(JSON.parse(r.body), { error: 'Internal error' });
    assertHardened(r, '500');
    assert.ok(logged.length > 0, 'the error is logged');
  } finally {
    registry.scanProjectsRoot = original;
    console.error = originalError;
  }
  assert.equal((await request(`${base}/api/health`)).status, 200);
});

// Invariant: startWebUI logs the missing entry file and still listens.
test('startWebUI logs a missing build and still starts', async () => {
  staticFiles._setDistDir(path.join(fakeDist({}), 'missing'));
  const logged = [];
  const originalError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  let s2;
  try {
    s2 = await startWebUI(0);
  } finally {
    console.error = originalError;
    staticFiles._setDistDir(fakeDist(files));
  }
  try {
    assert.ok(logged.some((l) => /^UI not built: .*index\.html is missing — run npm install$/.test(l)), logged.join('\n'));
    assert.equal((await request(`http://127.0.0.1:${s2.address().port}/api/health`)).status, 200);
  } finally {
    await new Promise((res) => s2.close(res));
  }
});
