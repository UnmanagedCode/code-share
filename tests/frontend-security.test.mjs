// Source guards for the plugin-ui.md Part 2 rules: content is never markup, no
// URL or style is built from content, no storage or parent scripting, and the
// page talks to its backend only through api() with relative paths (a `/`-led
// one would reach code-conductor's API, not this plugin's).
// Each sweep is a function over [file, text] pairs, run on the real sources and,
// as a positive control, on an in-memory planted offender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFiles } from './_frontendFiles.mjs';

const all = sourceFiles();
const own = all.filter(([n]) => !n.startsWith('src/components/ui/'));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const API_MODULE = 'src/lib/api.ts';

/** The files (with the matched text) where `re` occurs in code. */
const offenders = (files, re) => files.filter(([, src]) => re.test(code(src))).map(([n, src]) => `${n}: ${code(src).match(re)[0]}`);

const SINKS = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML|\beval\(|new Function/;
const STYLE_HREF = /\bstyle=\{|\bhref=\{/;
const FORBIDDEN_API = /localStorage|sessionStorage|window\.parent|pushState|location\.hash\s*=/;
// A bare or global fetch (a method of our own named fetch, like `ops.fetch(…)`, is not the network).
const NETWORK = /(?<![\w$.])fetch\s*\(|\b(?:window|globalThis|self)\.fetch\b|XMLHttpRequest|EventSource|WebSocket|sendBeacon/;

/** Files other than api.ts that open a network request themselves. */
const networkOutsideApi = (files) => offenders(files.filter(([n]) => n !== API_MODULE), NETWORK);

/**
 * api()/post() calls whose first argument is not a literal `api/…` path. The one exemption is the body of a
 * `post = (path…) => api(path, …)` wrapper, whose own call sites are checked like any other.
 */
function nonRelativeApiCalls(files) {
  const bad = [];
  for (const [n, src] of files.filter(([f]) => f !== API_MODULE)) {
    const text = code(src);
    for (const m of text.matchAll(/\b(?:api|post)(?:<[^>()]*>)?\(\s*(`[^`]*`|'[^']*'|"[^"]*"|[^,)]*)/g)) {
      const arg = m[1].trim();
      if (/^(['"`])api\/[^'"`]*\1$/.test(arg) || /^`api\/[^`]*`$/.test(arg)) continue;
      if (arg === 'path' && /const post\s*=\s*(?:<T,?>)?\(path\b[^)]*\)\s*=>\s*$/.test(text.slice(Math.max(0, m.index - 160), m.index))) continue;
      bad.push(`${n}: ${arg}`);
    }
  }
  return bad;
}
const apiCallCount = (files) => files.reduce((k, [, src]) => k + [...code(src).matchAll(/\b(?:api|post)(?:<[^>()]*>)?\(\s*['"`]api\//g)].length, 0);

// Invariant: the sweeps cover the whole UI: all sources, our own code, and every API call site.
test('the swept file sets are complete', () => {
  assert.ok(all.length > 20, `${all.length} files`);
  assert.ok(own.length > 25, `${own.length} own files`);
  assert.ok(all.some(([n]) => n === API_MODULE) && all.some(([n]) => n === 'connect.html'));
  assert.ok(apiCallCount(own) >= 12, `${apiCallCount(own)} api() calls`);
});

// Invariant: nothing turns a string into markup or code (copied components included).
test('no raw-HTML or eval sinks', () => {
  assert.deepEqual(offenders(all, SINKS), []);
});

// Invariant: the plugin's own code sets no inline style (CSP has no 'unsafe-inline') and builds no href,
// so there is no link scheme to allowlist.
test('no style or href props in own code', () => {
  assert.deepEqual(offenders(own, STYLE_HREF), []);
});

// Invariant: no storage (shared with code-conductor's origin), no parent scripting, no history pushes or hash writes.
test('no storage, parent scripting or history writes', () => {
  assert.deepEqual(offenders(all, FORBIDDEN_API), []);
});

// Invariant: only src/lib/api.ts opens a network request (it refuses a `/`-led path), so no computed URL can
// reach code-conductor's API; and every api() call passes a literal `api/…` path.
test('the network is reached only through api(), with literal relative paths', () => {
  assert.ok(NETWORK.test(code(all.find(([n]) => n === API_MODULE)[1])), 'api.ts itself calls fetch');
  assert.deepEqual(networkOutsideApi(all), []);
  assert.deepEqual(nonRelativeApiCalls(own), []);
});

// Positive control: each sweep reports a planted offender.
test('every sweep catches a planted offender', () => {
  const planted = (src) => [['src/components/Planted.tsx', src]];
  assert.equal(offenders(planted('el.innerHTML = name;'), SINKS).length, 1);
  assert.equal(offenders(planted('<div dangerouslySetInnerHTML={{ __html: x }} />'), SINKS).length, 1);
  assert.equal(offenders(planted('<a href={url}>x</a>'), STYLE_HREF).length, 1);
  assert.equal(offenders(planted('<p style={{ color }} />'), STYLE_HREF).length, 1);
  assert.equal(offenders(planted("localStorage.setItem('k', v)"), FORBIDDEN_API).length, 1);
  assert.equal(offenders(planted("location.hash = '#x'"), FORBIDDEN_API).length, 1);
  assert.equal(networkOutsideApi(planted("fetch(location.origin + '/api/status')")).length, 1);
  assert.equal(networkOutsideApi(planted("new WebSocket(u)")).length, 1);
  assert.equal(networkOutsideApi(planted("window.fetch(u)")).length, 1);
  assert.equal(networkOutsideApi(planted("const f = globalThis.fetch; f(u)")).length, 1);
  assert.equal(networkOutsideApi(planted("await ops.fetch(peer, project)")).length, 0);
  assert.equal(networkOutsideApi(planted("const x = new XMLHttpRequest()")).length, 1);
  assert.equal(nonRelativeApiCalls(planted("api('/api/status')")).length, 1);
  assert.equal(nonRelativeApiCalls(planted('api(base + "api/status")')).length, 1);
  assert.equal(nonRelativeApiCalls(planted("api('api/status')")).length, 0);
  assert.equal(nonRelativeApiCalls(planted('api(`api/peer-status?peer=${p}`)')).length, 0);
  assert.equal(nonRelativeApiCalls(planted('api(`api/x?p=${encodeURIComponent(p)}&q=${f(q)}`)')).length, 0);
  assert.equal(nonRelativeApiCalls(planted('api(`/api/x?p=${encodeURIComponent(p)}`)')).length, 1);
  assert.equal(nonRelativeApiCalls(planted('const post = (path: string, body: unknown) =>\n  api(path, { method: "POST" });')).length, 0);
  assert.equal(nonRelativeApiCalls(planted('const go = (path: string) => api(path);')).length, 1);
});
