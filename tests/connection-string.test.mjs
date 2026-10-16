// The backend's cs1: builder and the UI's (frontend/src/lib/connectionString.ts,
// checked against the same vector in connectionString.test.ts) must agree byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { require } from './_backend.mjs';

const { buildConnectionString } = require('../src/peer');
const vectors = JSON.parse(readFileSync(new URL('../frontend/src/test/cs1-vector.json', import.meta.url), 'utf8'));

// Invariant: buildConnectionString still produces the shared vector's expected strings.
test('buildConnectionString matches the shared cs1 vector', () => {
  assert.ok(vectors.length >= 3);
  for (const v of vectors) assert.equal(buildConnectionString(v.base, v.token), v.expected, v.base);
});
