// Loads the CommonJS backend for a test: PROJECTS_ROOT points at an empty
// temp dir, and ./tunnel is a stub, so nothing a test does can open a real
// tunnel (cloudflared may be on PATH).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PROJECTS_ROOT = mkdtempSync(path.join(os.tmpdir(), 'code-share-test-'));

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
