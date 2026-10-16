// Checks the real build (`npm install` runs `prepare`, which writes
// frontend/dist): it is what the CSP actually meets, and what the servers serve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { require } from './_backend.mjs';
import { PAGES, headRefs } from './_frontendFiles.mjs';

const { DEFAULT_DIST, UI_ASSET_RE, connectAssets } = require('../src/static');

const built = PAGES.every((p) => existsSync(path.join(DEFAULT_DIST, p)));
const files = [];
const walk = (rel) => {
  for (const e of readdirSync(path.join(DEFAULT_DIST, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(r); else files.push(r);
  }
};
if (built) walk('');
const read = (rel) => readFileSync(path.join(DEFAULT_DIST, rel), 'utf8');
const html = Object.fromEntries(PAGES.map((p) => [p, built ? read(p) : '']));
const HOST = ['/pluginBridge.js', '/pluginTheme.css'];
const refs = (page) => [...html[page].matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);

// Invariant: both pages are built (by `npm install`).
test('frontend/dist has index.html and connect.html', () => {
  assert.ok(built, `${DEFAULT_DIST}/{${PAGES.join(',')}} missing — run npm install`);
});

// Invariant: every built file except the manifest is servable by the static allowlist; the build is only
// html/js/css, and ships no source map.
test('every built file matches the served-path rule', () => {
  assert.ok(files.includes('.vite/manifest.json'), 'manifest');
  for (const f of files) {
    assert.equal(f.endsWith('.map'), false, `source map: ${f}`);
    if (f === '.vite/manifest.json' || PAGES.includes(f)) continue;
    assert.match(`/${f}`, UI_ASSET_RE, f);
  }
  assert.ok(files.some((f) => /^assets\/.+\.js$/.test(f)), 'a JS bundle');
  assert.ok(files.some((f) => /^assets\/.+\.css$/.test(f)), 'a CSS bundle');
  assert.ok(files.includes('theme-init.js'));
});

// Invariant: neither page has an inline script or style, and every URL is relative except index.html's two host URLs.
test('built pages: no inline script/style, relative URLs', () => {
  for (const page of PAGES) {
    const h = html[page];
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(h), false, `${page}: inline <script>`);
    assert.equal(/<style[\s>]/.test(h), false, `${page}: <style>`);
    assert.equal(/\sstyle\s*=/.test(h), false, `${page}: style=`);
    for (const u of refs(page)) {
      if (page === 'index.html' && HOST.includes(u)) continue;
      assert.ok(!/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(u), `${page}: not relative: ${u}`);
    }
  }
});

// Invariant: index.html keeps the host-contract head order: bridge, host sheet, theme-init.js, then the module.
test('index.html head order', () => {
  const order = headRefs(html['index.html']);
  assert.deepEqual(order.slice(0, 3), ['/pluginBridge.js', '/pluginTheme.css', 'theme-init.js']);
  assert.match(order[3], /^\.\/assets\/index-[A-Za-z0-9_-]+\.js$/);
});

// Invariant: connect.html (served by the git server, never in cc) loads no host URL, starts with theme-init.js,
// and every local file it loads is in the closure the git server serves without auth.
test('connect.html: no host URLs, theme-init first, everything it loads is public', () => {
  for (const u of HOST) assert.equal(html['connect.html'].includes(u), false, u);
  const order = headRefs(html['connect.html']);
  assert.equal(order[0], 'theme-init.js');
  assert.match(order[1], /^\.\/assets\/connect-[A-Za-z0-9_-]+\.js$/);
  const closure = connectAssets(JSON.parse(read('.vite/manifest.json')));
  for (const u of refs('connect.html')) {
    if (u === 'theme-init.js') continue;
    assert.ok(closure.has(u.replace(/^\.\//, '')), `${u} is not in connectAssets`);
  }
});

// Invariant: the CSS loads nothing the CSP forbids (no data: URL, nothing off-origin); the JS calls no root-relative API.
test('built CSS and JS reference nothing off-limits', () => {
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/url\(\s*['"]?data:/i.test(css), false, `${f}: url(data:`);
    assert.equal(/https?:\/\/|url\(\s*['"]?\/\//i.test(css), false, `${f}: absolute URL`);
  }
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    assert.equal(/["'`]\/api\//.test(read(f)), false, `${f}: root-relative /api/`);
  }
});
