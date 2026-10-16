// The cloudflared check before a tunnel is bounded. PATH points only at fake cloudflared scripts, so no real
// cloudflared runs and no tunnel ever starts (this file deliberately does not stub src/tunnel.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { LIMITS } = require('../src/limits');
const { ensureCloudflared } = require('../src/tunnel');

const DEFAULT = LIMITS.CLOUDFLARED_CHECK_TIMEOUT_MS;
const PATH = process.env.PATH;
// Resolved before PATH is narrowed to the fake bin.
const SLEEP = execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim();
after(() => { process.env.PATH = PATH; LIMITS.CLOUDFLARED_CHECK_TIMEOUT_MS = DEFAULT; });

/** A directory holding only a `cloudflared` script with `body`, or nothing when `body` is null. */
function fakeBin(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'code-share-fakebin-'));
  if (body !== null) {
    const f = path.join(dir, 'cloudflared');
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
  }
  return dir;
}

// Invariant: a cloudflared that never answers --version fails the check after LIMITS.CLOUDFLARED_CHECK_TIMEOUT_MS,
// with a message that says so (not "not found").
test('a hanging cloudflared --version is cut off', () => {
  process.env.PATH = fakeBin(`exec ${SLEEP} 30`);
  LIMITS.CLOUDFLARED_CHECK_TIMEOUT_MS = 500;
  const t = Date.now();
  assert.throws(() => ensureCloudflared(), /^Error: cloudflared --version did not answer within 1s$/);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t}ms`);
});

// Invariant: the check's outcomes are otherwise unchanged: a working cloudflared passes, a missing one is "not found".
test('a working cloudflared passes; a missing one is reported', () => {
  LIMITS.CLOUDFLARED_CHECK_TIMEOUT_MS = DEFAULT;
  process.env.PATH = fakeBin('echo "cloudflared version 0 (fake)"');
  assert.equal(ensureCloudflared(), 'cloudflared');
  process.env.PATH = fakeBin(null);
  assert.throws(() => ensureCloudflared(), /cloudflared not found in PATH/);
});
