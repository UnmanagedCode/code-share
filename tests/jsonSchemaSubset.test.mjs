// The test-only port of code-conductor's schema subset validator, which the manifest outputSchemas are checked with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkSchema, validate, KEYWORDS, TYPES } from './_jsonSchemaSubset.mjs';

// Invariant: keywords outside the subset are schema errors, so a schema can't lean on one the validator ignores.
test('checkSchema rejects pattern, $ref and oneOf', () => {
  for (const kw of ['pattern', '$ref', 'oneOf']) {
    assert.throws(() => checkSchema({ type: 'string', [kw]: 'x' }), /outside the validated subset/);
  }
});

// Invariant: every schema admitting an object states additionalProperties, in a union too.
test('checkSchema requires additionalProperties on an object type, including in a union', () => {
  assert.throws(() => checkSchema({ type: 'object', properties: {} }), /additionalProperties/);
  assert.throws(() => checkSchema({ type: ['object', 'null'] }), /additionalProperties/);
  checkSchema({ type: ['object', 'null'], additionalProperties: false });
});

// Invariant: `required` can only name declared properties.
test('checkSchema rejects a required key that is not a property', () => {
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['b'] }), /not a property/);
});

// Invariant: type unions are valid and unknown types are refused.
test('checkSchema accepts unions and rejects unknown types', () => {
  checkSchema({ type: ['string', 'null'] });
  assert.throws(() => checkSchema({ type: 'float' }), /unknown type/);
});

// Invariant: validate reports type, enum, required and unexpected-property errors, and passes valid values.
test('validate reports each class of mismatch', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['a'],
    properties: { a: { type: 'string', enum: ['x'] }, n: { type: ['integer', 'null'] } },
  };
  assert.deepEqual(validate(schema, { a: 'x', n: null }), []);
  assert.match(validate(schema, { a: 1 })[0], /expected string/);
  assert.match(validate(schema, { a: 'y' })[0], /not one of/);
  assert.match(validate(schema, {})[0], /missing required 'a'/);
  assert.match(validate(schema, { a: 'x', z: 1 })[0], /unexpected property 'z'/);
  assert.match(validate(schema, { a: 'x', n: 1.5 })[0], /expected integer\|null/);
});

// Invariant: the port's keyword and type sets equal code-conductor's source (runs when CODE_CONDUCTOR_DIR is set).
test('KEYWORDS and TYPES match code-conductor', { skip: !process.env.CODE_CONDUCTOR_DIR }, () => {
  const file = path.join(process.env.CODE_CONDUCTOR_DIR, 'src/mcp/jsonSchemaSubset.ts');
  assert.ok(existsSync(file), file);
  const src = readFileSync(file, 'utf8');
  const setOf = (name) => [...src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual([...KEYWORDS].sort(), setOf('KEYWORDS').sort());
  assert.deepEqual([...TYPES].sort(), setOf('TYPES').sort());
});
