// Unit checks of src/static.js: what each server may serve from frontend/dist.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { require, fakeDist } from './_backend.mjs';

const s = require('../src/static');
after(() => s._setDistDir(null));

const MANIFEST = {
  'index.html': { file: 'assets/index-AAAA.js', isEntry: true, imports: ['_shared.js'], css: ['assets/index-only.css'] },
  'connect.html': { file: 'assets/connect-BBBB.js', isEntry: true, imports: ['_shared.js'] },
  '_shared.js': { file: 'assets/chunk-CCCC.js', css: ['assets/src-DDDD.css'], imports: ['_deep.js'] },
  '_deep.js': { file: 'assets/chunk-EEEE.js', assets: ['assets/logo-FFFF.css'], imports: ['_shared.js'] },
  '_lazy.js': { file: 'assets/chunk-GGGG.js' },
};

// Invariant: the git server's unauthenticated asset set is exactly connect.html's import closure
// (entry file, css and assets of every chunk it reaches, cycles included) and nothing of index.html's own.
test('connectAssets follows connect.html imports recursively and excludes the index entry', () => {
  assert.deepEqual(
    [...s.connectAssets(MANIFEST)].sort(),
    ['assets/chunk-CCCC.js', 'assets/chunk-EEEE.js', 'assets/connect-BBBB.js', 'assets/logo-FFFF.css', 'assets/src-DDDD.css'],
  );
  assert.deepEqual([...s.connectAssets({})], []);
});

const files = {
  'index.html': '<!doctype html><title>i</title>',
  'connect.html': '<!doctype html><title>c</title>',
  'theme-init.js': '/* t */',
  'assets/index-AAAA.js': 'i',
  'assets/index-AAAA.js.map': '{}',
  'assets/connect-BBBB.js': 'c',
  'assets/chunk-CCCC.js': 's',
  'assets/src-DDDD.css': 'x{}',
  '.vite/manifest.json': JSON.stringify(MANIFEST),
};
const body = (r) => r && r.body.toString('utf8');

// Invariant: the web UI serves index.html at / and /index.html, and hashed .js/.css assets with their types;
// nothing else of dist (maps, the manifest, traversal) and no host URL is servable.
test('serveUi serves the page and assets only', () => {
  s._setDistDir(fakeDist(files));
  assert.equal(body(s.serveUi('/')), files['index.html']);
  assert.equal(s.serveUi('/').headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(s.serveUi('/').headers['Cache-Control'], 'no-cache');
  assert.equal(body(s.serveUi('/index.html')), files['index.html']);
  assert.equal(s.serveUi('/assets/index-AAAA.js').headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(s.serveUi('/assets/src-DDDD.css').headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal(body(s.serveUi('/theme-init.js')), files['theme-init.js']);
  for (const p of ['/assets/index-AAAA.js.map', '/.vite/manifest.json', '/assets/../index.html', '/assets/../x.js',
    '/assets/%2e%2e/x.js', '/assets/missing-ZZZZ.js', '/connect.html', '/pluginBridge.js', '/pluginTheme.css', '/x']) {
    assert.equal(s.serveUi(p), null, p);
  }
});

// Invariant: with no build, / answers a plain-text 503 that says how to fix it, never HTML.
test('serveUi answers 503 text/plain while the UI is not built', () => {
  s._setDistDir(path.join(fakeDist({}), 'missing'));
  for (const p of ['/', '/index.html']) {
    const r = s.serveUi(p);
    assert.equal(r.status, 503);
    assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.match(body(r), /UI not built — run npm install/);
  }
  assert.equal(s.serveUi('/assets/index-AAAA.js'), null);
});

// Invariant: the git server serves /connect, theme-init.js and connect's closure without auth; any other
// /assets/* is a plain 404 (not null, so it never reaches the auth challenge); other paths fall through.
test('serveConnect serves the connect page and its closure only', () => {
  s._setDistDir(fakeDist(files));
  assert.equal(body(s.serveConnect('/connect')), files['connect.html']);
  assert.equal(body(s.serveConnect('/theme-init.js')), files['theme-init.js']);
  assert.equal(body(s.serveConnect('/assets/connect-BBBB.js')), 'c');
  assert.equal(body(s.serveConnect('/assets/src-DDDD.css')), 'x{}');
  for (const p of ['/assets/index-AAAA.js', '/assets/index-AAAA.js.map', '/assets/../connect.html', '/assets/chunk-EEEE.js']) {
    const r = s.serveConnect(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8', p);
  }
  for (const p of ['/', '/index.html', '/connect.html', '/.vite/manifest.json', '/control/status', '/x.git/info/refs']) {
    assert.equal(s.serveConnect(p), null, p);
  }
});

// Invariant: with no build, /connect is a plain-text 503 rather than an auth challenge or a crash.
test('serveConnect answers 503 for /connect while the UI is not built', () => {
  s._setDistDir(path.join(fakeDist({}), 'missing'));
  const r = s.serveConnect('/connect');
  assert.equal(r.status, 503);
  assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(s.serveConnect('/assets/connect-BBBB.js').status, 404);
});

// Invariant: routing uses the path without query or fragment, and never throws on a malformed target.
test('pathOf strips query and fragment and never throws', () => {
  assert.equal(s.pathOf('/connect?x=1'), '/connect');
  assert.equal(s.pathOf('/connect#a?b'), '/connect');
  assert.equal(s.pathOf('http://[bad'), 'http://[bad');
  assert.equal(s.pathOf(undefined), '');
});
