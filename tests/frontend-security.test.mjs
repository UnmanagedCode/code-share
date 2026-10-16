// Source guards for the plugin-ui.md Part 2 rules: content is never markup, no
// URL or style is built from content, no storage or parent scripting, and every
// request is relative (a `/`-led one would reach cc's API, not this plugin's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFiles } from './_frontendFiles.mjs';

const all = sourceFiles();
const own = all.filter(([n]) => !n.startsWith('src/components/ui/'));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const check = (files, re, what) => {
  for (const [n, src] of files) assert.equal(re.test(code(src)), false, `${n}: ${what}: ${code(src).match(re)?.[0]}`);
};

// Invariant: nothing turns a string into markup or code (copied components included).
test('no raw-HTML or eval sinks', () => {
  assert.ok(all.length > 20, all.length);
  check(all, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML|\beval\(|new Function/, 'HTML/code sink');
});

// Invariant: the plugin's own code sets no inline style (CSP has no 'unsafe-inline') and builds no href,
// so there is no link scheme to allowlist.
test('no style or href props in own code', () => {
  check(own, /\bstyle=\{|\bhref=\{/, 'style/href prop');
});

// Invariant: no storage (shared with cc's origin), no parent scripting, no history pushes or hash writes.
test('no storage, parent scripting or history writes', () => {
  check(all, /localStorage|sessionStorage|window\.parent|pushState|location\.hash\s*=/, 'forbidden API');
});

// Invariant: every api()/fetch() string or template argument is relative.
test('every request path is relative', () => {
  const calls = [];
  // src/lib/api.ts defines api() and refuses a root-relative path at run time.
  for (const [n, src] of own.filter(([f]) => f !== 'src/lib/api.ts')) {
    for (const m of code(src).matchAll(/\b(?:api(?:<[^>()]*>)?|fetch|post(?:<[^>()]*>)?)\(\s*(['"`])([^'"`]*)\1?/g)) calls.push([n, m[2]]);
  }
  assert.ok(calls.length >= 10, calls.map((c) => c.join(' ')).join('\n'));
  for (const [n, u] of calls) {
    assert.ok(!/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(u), `${n}: ${u}`);
    assert.match(u, /^api\//, `${n}: ${u}`);
  }
});
