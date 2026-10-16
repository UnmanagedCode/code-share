// Pins the theme wiring: cc's tokens with a standalone fallback for both
// modes, colours only through tokens, and no theme control of the plugin's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND, sourceFiles } from './_frontendFiles.mjs';

const read = (rel) => readFileSync(path.join(FRONTEND, rel), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const fallback = strip(read('src/cc-theme-fallback.css'));
const indexCss = strip(read('src/index.css'));

// The body of the first `<selector> {…}` block (no nested braces inside).
const block = (css, selector) => css.match(new RegExp(`(?:^|[\\s}])${selector.replace('.', '\\.')}\\s*\\{([^{}]*)\\}`))?.[1];
const declared = (body) => new Set([...(body ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Invariant: the fallback is one @layer base block (so cc's unlayered sheet wins embedded) declaring :root and .dark.
test('cc-theme-fallback.css is wrapped in @layer base and declares :root and .dark', () => {
  assert.match(fallback.trim(), /^@layer base \{[\s\S]*\}$/);
  assert.equal(fallback.match(/@layer\b/g).length, 1, 'one @layer');
  assert.ok(declared(block(fallback, ':root')).size > 10, ':root tokens');
  assert.ok(declared(block(fallback, '.dark')).size > 10, '.dark tokens');
});

// Invariant: standalone, every token @theme inline maps resolves in light, and every colour token in dark too.
test('every @theme inline token is declared by the fallback, colours in both modes', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(theme, '@theme inline block');
  const light = declared(block(fallback, ':root'));
  const dark = declared(block(fallback, '.dark'));
  const used = [...theme.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
  assert.ok(used.length > 20);
  for (const [, name, value] of used) {
    for (const [, v] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      assert.ok(light.has(v), `${name}: var(${v}) not declared in :root`);
      if (name.startsWith('--color-')) assert.ok(dark.has(v), `${name}: var(${v}) not declared in .dark`);
    }
  }
});

// Invariant: index.css pulls in Tailwind, the animations, the fallback, and cc's class-based dark variant.
test('index.css imports and dark variant', () => {
  for (const imp of ['tailwindcss', 'tw-animate-css', './cc-theme-fallback.css']) {
    assert.match(indexCss, new RegExp(`@import ['"]${imp.replace(/[./]/g, '\\$&')}['"];`), imp);
  }
  assert.match(indexCss, /@custom-variant dark \(&:is\(\.dark \*\)\);/);
});

// The QR code is black on white whatever the theme: scanners need that contrast.
const LITERAL_COLOUR_EXEMPT = new Set(['src/components/QrCode.tsx']);
const own = sourceFiles().filter(([n]) => n.startsWith('src/') && !n.startsWith('src/components/ui/')
  && n !== 'src/cc-theme-fallback.css' && !LITERAL_COLOUR_EXEMPT.has(n));

// Invariant: the plugin's own code uses colours only through the theme tokens.
test('own code has no literal colours', () => {
  const PALETTE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white';
  const literal = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(|\\boklch\\(|\\b(?:bg|text|border|ring|fill|stroke|outline|decoration|shadow|from|via|to|divide|accent|caret)-(?:${PALETTE})\\b`);
  assert.ok(own.length >= 8, own.map(([n]) => n).join(', '));
  for (const [n, src] of own) assert.equal(literal.test(src), false, `${n}: ${src.match(literal)?.[0]}`);
});

// Invariant: only public/theme-init.js (standalone) touches the dark class or data-cc-theme, or reads the OS
// theme; cc's choice applies embedded, and there is no toggle of the plugin's own.
test('no theme control of the plugin\'s own', () => {
  const mutates = /classList\.(?:add|remove|toggle|replace)\(\s*['"]dark['"]|(?:set|remove|toggle)Attribute\(\s*['"]data-cc-theme|prefers-color-scheme/;
  for (const [n, src] of sourceFiles()) {
    if (n === 'public/theme-init.js') {
      assert.match(src, /classList\.toggle\('dark'/);
      continue;
    }
    assert.equal(mutates.test(src), false, `${n}: ${src.match(mutates)?.[0]}`);
  }
});
