// Calls the MCP dispatcher the way code-conductor's bridge does and asserts the reply's contract shape.
// Import ./_isolatedData.mjs before this file.
import assert from 'node:assert/strict';
import { require } from './_backend.mjs';
import { checkSchema, validate, outputSchemaOf } from './_jsonSchemaSubset.mjs';

const { handle } = require('../src/mcp');

const CODE = /^[A-Z][A-Z0-9_]*$/;
const keysWithin = (o, allowed) => Object.keys(o).every(k => allowed.includes(k));

/** Asserts `reply` is a well-formed refusal. */
export function assertRefusal(reply) {
  assert.ok(keysWithin(reply, ['error', 'code', 'details']), `refusal keys: ${Object.keys(reply)}`);
  assert.match(reply.code, CODE);
  assert.equal(typeof reply.error, 'string');
  assert.ok(!reply.error.startsWith(`${reply.code}:`), 'the message must not repeat the code as a prefix');
  if ('details' in reply) {
    assert.ok(reply.details && typeof reply.details === 'object' && !Array.isArray(reply.details), 'details is a plain object');
  }
}

/**
 * Invokes `tool`; `format` undefined omits the key. Returns the reply after asserting its shape:
 * a refusal, or {structured} valid against the manifest outputSchema, or {text} prose.
 */
export async function call(tool, args = {}, format) {
  const body = { tool, arguments: args, caller: { sessionId: null, project: null } };
  if (format !== undefined) body.format = format;
  const reply = await handle(body);
  if ('error' in reply) {
    assertRefusal(reply);
    return reply;
  }
  if (format === 'json') {
    assert.deepEqual(Object.keys(reply), ['structured']);
    const schema = outputSchemaOf(tool);
    checkSchema(schema);
    assert.deepEqual(validate(schema, JSON.parse(JSON.stringify(reply.structured))), []);
  } else {
    assert.ok(keysWithin(reply, ['text', 'meta']), `text keys: ${Object.keys(reply)}`);
    assert.ok(typeof reply.text === 'string' && reply.text !== '');
    let parsed;
    try { parsed = JSON.parse(reply.text); } catch { /* prose */ }
    assert.ok(!(parsed && typeof parsed === 'object'), 'the text view is prose, not JSON');
  }
  return reply;
}

/** Calls in both formats; returns {json, text} replies. */
export async function callBoth(tool, args) {
  return { json: await call(tool, args, 'json'), text: await call(tool, args, 'text') };
}
