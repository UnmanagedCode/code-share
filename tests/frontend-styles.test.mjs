// Pins: static/ui.html and static/connect.html are dark-only, carry one shared
// copy of code-conductor's shell :root tokens, use the host font (monospace only
// via the host's ui-monospace stack), reference no custom property they don't
// declare, and keep none of the legacy GitHub-dark palette.
// Reads the pages as text: the styles are inline <style> blocks, inline style
// attributes and JS colour strings, and happy-dom doesn't resolve cascaded
// custom properties reliably.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['static/ui.html', 'static/connect.html'];
const SHELL_TOKENS = ['--bg', '--panel', '--panel-2', '--text', '--muted', '--border', '--accent', '--green', '--amber', '--red'];
const LEGACY_HEX = /#(0d1117|161b22|30363d|21262d|e6edf3|8b949e|58a6ff|238636|2ea043|b62324|da3633|f85149|3fb950|1a4731|1c3452|264a70|3d2e00|d29922|3d1f00|f0883e)\b/i;

function load(file) {
  const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
  const root = rootMatch ? rootMatch[1] : '';
  const declared = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  return { html, css, rootMatch, root, declared };
}

const pages = Object.fromEntries(FILES.map((f) => [f, load(f)]));

for (const file of FILES) {
  const { html, css, rootMatch, root, declared } = pages[file];

  test(`${file}: :root block exists`, () => {
    assert.ok(rootMatch, `${file} has no :root block`);
  });

  test(`${file}: dark-only: no prefers-color-scheme query, :root declares color-scheme: dark`, () => {
    assert.doesNotMatch(html, /prefers-color-scheme/);
    assert.match(root, /(^|[;\s])color-scheme\s*:\s*dark\s*(;|$)/);
  });

  test(`${file}: declares the host shell's token names on :root`, () => {
    for (const name of SHELL_TOKENS) {
      assert.ok(declared.has(name), `:root does not declare ${name}`);
    }
  });

  test(`${file}: every var(--name) used (CSS, inline styles, JS strings) is declared on :root`, () => {
    const used = new Set([...html.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    assert.ok(used.size > 0);
    for (const name of used) assert.ok(declared.has(name), `var(${name}) is not declared on :root`);
  });

  test(`${file}: host font on :root, monospace only via the ui-monospace stack`, () => {
    assert.match(root, /font-family\s*:[^;]*system-ui/);
    const rest = css.replace(/:root\s*\{[^}]*\}/, '');
    for (const m of rest.matchAll(/font-family\s*:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      assert.ok(value === 'inherit' || value.startsWith('ui-monospace'), `unexpected font-family: ${value}`);
    }
  });

  test(`${file}: no legacy palette colours`, () => {
    assert.doesNotMatch(html, LEGACY_HEX);
  });
}

test('both pages carry one identical :root palette', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const [a, b] = FILES.map((f) => norm(pages[f].root));
  assert.ok(a, `${FILES[0]} :root is empty`);
  assert.equal(a, b);
});
