'use strict';
// Serves the built UI (frontend/dist, written by `npm install`'s `prepare`).
// The web UI serves index.html and its assets; the git server serves only
// connect.html and the files that page needs, unauthenticated.
const fs = require('fs');
const path = require('path');

const DEFAULT_DIST = path.join(__dirname, '../frontend/dist');
let distDir = DEFAULT_DIST;

/** Test seam: serve from another dist directory (null restores the default). */
function _setDistDir(dir) {
  distDir = dir || DEFAULT_DIST;
}

function distFile(name) {
  return path.join(distDir, name);
}

// Built asset names carry a base64url hash; nothing else (no .map, no .vite/) is servable.
const UI_ASSET_RE = /^\/(theme-init\.js|assets\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:js|css))$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// A response for the router to send: { status, headers, body }.
function fileResponse(rel) {
  let body;
  try {
    body = fs.readFileSync(distFile(rel));
  } catch {
    return null;
  }
  return {
    status: 200,
    headers: { 'Content-Type': TYPES[path.extname(rel)], 'Cache-Control': 'no-cache', 'Content-Length': body.length },
    body,
  };
}

function textResponse(status, text) {
  const body = Buffer.from(text + '\n', 'utf8');
  return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length }, body };
}

const notBuilt = () => textResponse(503, 'UI not built — run npm install');

/** The web UI's static routes: `/` → index.html (503 while unbuilt), an asset → the file; null for anything else. */
function serveUi(pathname) {
  if (pathname === '/' || pathname === '/index.html') return fileResponse('index.html') || notBuilt();
  const m = UI_ASSET_RE.exec(pathname);
  return m ? fileResponse(m[1]) : null;
}

/** The `assets/…` files connect.html loads: its entry's file, css and assets, and those of its imports, recursively. */
function connectAssets(manifest) {
  const out = new Set();
  const seen = new Set();
  const visit = (key) => {
    const chunk = manifest[key];
    if (!chunk || seen.has(key)) return;
    seen.add(key);
    if (chunk.file) out.add(chunk.file);
    for (const f of chunk.css || []) out.add(f);
    for (const f of chunk.assets || []) out.add(f);
    for (const k of chunk.imports || []) visit(k);
    for (const k of chunk.dynamicImports || []) visit(k);
  };
  visit('connect.html');
  return out;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(distFile('.vite/manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The git server's unauthenticated static routes: `/connect`, `/theme-init.js`, and
 * connect.html's own assets (any other `/assets/*` is a plain 404, never an auth
 * challenge). Null for anything else, which then goes through token auth.
 */
function serveConnect(pathname) {
  if (pathname === '/connect') return fileResponse('connect.html') || notBuilt();
  if (pathname === '/theme-init.js') return fileResponse('theme-init.js') || textResponse(404, 'Not found');
  if (pathname.startsWith('/assets/')) {
    const m = UI_ASSET_RE.exec(pathname);
    // Read per request, so a rebuild needs no restart.
    if (m && connectAssets(readManifest()).has(m[1])) return fileResponse(m[1]) || textResponse(404, 'Not found');
    return textResponse(404, 'Not found');
  }
  return null;
}

/** The path of a raw request target, without query or fragment. Never throws, unlike `new URL`. */
function pathOf(rawUrl) {
  return String(rawUrl || '').split(/[?#]/, 1)[0];
}

/** Writes a response from serveUi/serveConnect; HEAD gets the headers only. */
function send(req, res, r) {
  res.writeHead(r.status, r.headers);
  res.end(req.method === 'HEAD' ? undefined : r.body);
}

module.exports = { DEFAULT_DIST, _setDistDir, distFile, UI_ASSET_RE, serveUi, connectAssets, serveConnect, pathOf, send };
