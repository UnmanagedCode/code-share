// The MCP dispatcher: format, tool and argument handling, and the HTTP wrapper.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, require } from './_backend.mjs';
import './_isolatedData.mjs';
import { call } from './_mcpCall.mjs';

const { handle, TOOL_NAMES } = require('../src/mcp');
const registry = require('../src/registry');
const { startWebUI } = require('../src/webui');

const caller = { sessionId: null, project: null };

// Invariant: any unrecognised format is refused with FORMAT_UNKNOWN and a bounded message, whatever its type or depth.
test('FORMAT_UNKNOWN for every non-text/json format, with a bounded reply', async () => {
  let deep = [];
  for (let i = 0; i < 9000; i++) deep = [deep];
  const circular = {}; circular.self = circular;
  for (const format of ['xml', null, 42, '', 'x'.repeat(5000), {}, [], 10n, Symbol('s'), deep, circular, 'JSON']) {
    const r = await handle({ tool: 'status', arguments: {}, caller, format });
    assert.equal(r.code, 'FORMAT_UNKNOWN', typeof format);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'error']);
    assert.ok(r.error.length < 200, r.error.length);
  }
});

// Invariant: a request without `format` is a text request, for every tool.
test('no format answers {text} for every tool', async () => {
  for (const tool of TOOL_NAMES) {
    const r = await call(tool, {});
    if (!('error' in r)) assert.deepEqual(Object.keys(r), ['text']);
  }
  const r = await call('status', {});
  assert.ok('text' in r);
});

// Invariant: only own tool names dispatch; prototype keys and non-strings are TOOL_UNKNOWN in both formats.
test('TOOL_UNKNOWN for unknown, inherited and non-string tools', async () => {
  for (const tool of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty', undefined, 7, null, {}]) {
    for (const format of ['text', 'json']) {
      const r = await handle({ tool, arguments: {}, caller, format });
      assert.equal(r.code, 'TOOL_UNKNOWN', String(tool));
      assert.deepEqual(Object.keys(r).sort(), ['code', 'error']);
    }
  }
  assert.equal((await handle({})).code, 'TOOL_UNKNOWN');
  assert.equal((await handle(undefined)).code, 'TOOL_UNKNOWN');
});

// Invariant: `arguments` must be an object (null/absent mean none).
test('BAD_REQUEST for non-object arguments', async () => {
  for (const args of ['x', [1], 5, true]) {
    const r = await handle({ tool: 'status', arguments: args, caller });
    assert.equal(r.code, 'BAD_REQUEST', JSON.stringify(args));
    assert.equal(r.error, 'arguments must be an object');
  }
  for (const args of [undefined, null]) assert.ok('text' in await handle({ tool: 'status', arguments: args, caller }));
});

// Invariant: an unexpected (non-coded) failure is INTERNAL, never a throw out of handle().
test('INTERNAL for an unexpected error', async () => {
  const saved = registry.addProject;
  const err = console.error;
  console.error = () => {};
  registry.addProject = () => { throw new Error('boom'); };
  try {
    const r = await call('share', { repoPath: '/nowhere' }, 'json');
    assert.equal(r.code, 'INTERNAL');
    assert.match(r.error, /share failed unexpectedly: boom/);
  } finally {
    registry.addProject = saved;
    console.error = err;
  }
});

let ui;
before(async () => { ui = await startWebUI(0); });
after(() => new Promise((res) => ui.close(res)));

// Invariant: an unparseable body is still HTTP 200 with a coded refusal, so the bridge sees a tool-level failure.
test('an invalid JSON body over HTTP is 200 BAD_REQUEST', async () => {
  const r = await request(`http://127.0.0.1:${ui.address().port}/api/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { error: 'Invalid JSON body', code: 'BAD_REQUEST' });
});
