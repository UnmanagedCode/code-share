// conductor.plugin.json declares typed tools: each has an outputSchema within the validated subset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { require } from './_backend.mjs';
import './_isolatedData.mjs';
import { checkSchema, manifestTools } from './_jsonSchemaSubset.mjs';

const { TOOL_NAMES } = require('../src/mcp');

// Invariant: every tool is typed: an object-rooted outputSchema that passes the strict subset check.
test('every manifest tool has a valid object outputSchema', () => {
  assert.ok(manifestTools().length > 0);
  for (const t of manifestTools()) {
    assert.equal(t.outputSchema?.type, 'object', t.name);
    checkSchema(t.outputSchema);
  }
});

// Invariant: the manifest and the dispatcher serve the same tools.
test('manifest tool names equal the dispatcher TOOL_NAMES', () => {
  assert.deepEqual(manifestTools().map(t => t.name).sort(), [...TOOL_NAMES].sort());
});

// Invariant: descriptions are format-neutral: they never name a wire format or say what a tool "returns".
test('no description names json or returns', () => {
  const walk = (s, found) => {
    if (!s || typeof s !== 'object') return;
    if (typeof s.description === 'string') found.push(s.description);
    for (const v of Object.values(s)) walk(v, found);
  };
  for (const t of manifestTools()) {
    const found = [];
    walk(t, found);
    assert.ok(found.length > 0);
    for (const d of found) assert.doesNotMatch(d, /\b(json|returns?)\b/i, `${t.name}: ${d}`);
  }
});

// Invariant: secret-bearing fields are optional everywhere, so redacting them later is not a schema break.
test('no required list names a secret-bearing field', () => {
  const secret = ['selfUrl', 'tunnelUrl', 'url', 'token'];
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s.required)) for (const k of s.required) assert.ok(!secret.includes(k), `required ${k}`);
    for (const v of Object.values(s)) walk(v);
  };
  for (const t of manifestTools()) walk(t.outputSchema);
  // The walk must be able to see the fields it guards.
  const status = manifestTools().find(t => t.name === 'status').outputSchema;
  assert.ok('selfUrl' in status.properties && 'token' in status.properties.peers.items.properties);
});
