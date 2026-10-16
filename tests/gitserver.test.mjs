// The git server (src/server.js) over HTTP: the connect page and its files are
// public, everything else still needs the token, and every response is hardened.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { require, request, fakeDist } from './_backend.mjs';

const { startServer, CONNECT_CSP } = require('../src/server');
const staticFiles = require('../src/static');
const { DEFAULT_DIST, connectAssets } = staticFiles;

const TOKEN = 'tok';
const AUTH = { authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` };
const read = (rel) => readFileSync(path.join(DEFAULT_DIST, rel), 'utf8');
let server;
let base;
before(async () => {
  ({ server } = await startServer(0, TOKEN, '127.0.0.1'));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  staticFiles._setDistDir(null);
  await new Promise((res) => server.close(res));
});

function assertHardened(r, what) {
  assert.equal(r.headers.get('content-security-policy'), CONNECT_CSP, `${what}: CSP`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
}

// Invariant: the public origin's policy: no inline anything, never framed, no form posts, no fonts or images.
test('CONNECT_CSP is the strict public policy', () => {
  assert.equal(CONNECT_CSP, "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
});

// Invariant: with no credentials, /connect (with or without a query) is the built page, and every file of its
// manifest closure plus theme-init.js is served, all hardened.
test('/connect and its files are served without auth', async () => {
  for (const p of ['/connect', '/connect?from=qr']) {
    const r = await request(base + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8', p);
    assert.equal(r.body, read('connect.html'), p);
    assertHardened(r, p);
  }
  const closure = [...connectAssets(JSON.parse(read('.vite/manifest.json')))];
  assert.ok(closure.some((f) => f.endsWith('.js')) && closure.some((f) => f.endsWith('.css')), closure.join(', '));
  for (const f of [...closure, 'theme-init.js']) {
    const r = await request(`${base}/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.body, read(f), f);
    assertHardened(r, f);
  }
  const head = await request(`${base}/connect`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

// Invariant: the UI's own entry chunk is not public, and asking for it is a plain 404, never an auth challenge.
test('a non-closure asset is a 404 without WWW-Authenticate', async () => {
  const manifest = JSON.parse(read('.vite/manifest.json'));
  const indexEntry = manifest['index.html'].file;
  assert.equal(connectAssets(manifest).has(indexEntry), false);
  for (const p of [`/${indexEntry}`, '/assets/nope-ZZZZ.js', '/assets/x.js.map']) {
    const r = await request(base + p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('www-authenticate'), null, p);
    assertHardened(r, p);
  }
});

// Invariant: everything else still needs the token (401 with the challenge), push is refused (403),
// and git responses from node-git-server carry the headers too.
test('auth, push refusal and git responses are unchanged and hardened', async () => {
  for (const p of ['/control/status', '/index.html', '/', '/x.git/info/refs?service=git-upload-pack']) {
    const r = await request(base + p);
    assert.equal(r.status, 401, p);
    assert.equal(r.headers.get('www-authenticate'), 'Basic realm="code-share"', p);
    assertHardened(r, p);
  }
  const bad = await request(`${base}/control/status`, { headers: { authorization: 'Basic eDp3cm9uZw==' } });
  assert.equal(bad.status, 401);
  const push = await request(`${base}/x.git/git-receive-pack`, { method: 'POST', headers: AUTH });
  assert.equal(push.status, 403);
  assertHardened(push, 'push');
  const git = await request(`${base}/no-such-repo.git/info/refs?service=git-upload-pack`, { headers: AUTH });
  assert.ok(git.status >= 400, `git status ${git.status}`);
  assertHardened(git, 'git response');
});

// Invariant: with no build, /connect is a text/plain 503 (hardened), not an auth challenge.
test('/connect is a hardened 503 while the UI is not built', async () => {
  staticFiles._setDistDir(path.join(fakeDist({}), 'missing'));
  try {
    const r = await request(`${base}/connect`);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(r.headers.get('www-authenticate'), null);
    assertHardened(r, '503');
  } finally {
    staticFiles._setDistDir(null);
  }
});
