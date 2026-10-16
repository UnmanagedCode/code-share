// Loads the CommonJS backend for a test: PROJECTS_ROOT points at an empty
// temp dir, and ./tunnel is a stub, so nothing a test does can open a real
// tunnel (cloudflared may be on PATH).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Inside a private parent, so a test can check that nothing appears beside the root either.
process.env.PROJECTS_ROOT = path.join(mkdtempSync(path.join(os.tmpdir(), 'code-share-test-')), 'root');
mkdirSync(process.env.PROJECTS_ROOT);

export const require = createRequire(import.meta.url);

const tunnelPath = require.resolve('../src/tunnel');
if (!require.cache[tunnelPath]) {
  const refuse = () => { throw new Error('tests never start a real tunnel'); };
  require.cache[tunnelPath] = {
    id: tunnelPath, filename: tunnelPath, loaded: true,
    exports: new Proxy({}, { get: () => refuse }),
  };
}

/** Requests `url`; resolves {status, headers, body}. */
export async function request(url, init) {
  const r = await fetch(url, { redirect: 'manual', ...init });
  return { status: r.status, headers: r.headers, body: await r.text() };
}

/** A throwaway dist dir holding `files` ({relative path: text}). */
export function fakeDist(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'code-share-dist-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

/** Processes (pid and command line) whose command line contains `pattern`; pgrep runs without a shell, so it never matches itself. */
export function processesMatching(pattern) {
  try {
    return execFileSync('pgrep', ['-af', pattern], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Polls `check` every 50 ms until it returns truthy or `ms` pass; resolves its last value. */
export async function eventually(check, ms = 5000) {
  const end = Date.now() + ms;
  let value = await check();
  while (!value && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    value = await check();
  }
  return value;
}
