// Ending `serve` ends the git commands it started: they run in their own process groups, which the signal to
// serve does not reach, so serve kills them itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, processesMatching } from './_backend.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// A copy of the backend in a temp dir, so serve's data/ (config, registry) is that copy's, never this checkout's.
function scratchCheckout() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'code-share-serve-'));
  for (const p of ['bin', 'src', 'package.json']) cpSync(path.join(REPO, p), path.join(dir, p), { recursive: true });
  symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

const held = new Set();
const silent = net.createServer((s) => { held.add(s); s.on('error', () => {}); });
after(async () => {
  for (const s of held) s.destroy();
  await new Promise((r) => silent.close(() => r()));
});

// Invariant: SIGTERM to serve during a stalled fetch exits serve promptly (code 0) and leaves no git process for
// that peer behind. The in-flight check is the positive control.
test('SIGTERM to serve kills its in-flight git commands', async () => {
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const marker = `serve-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const dir = scratchCheckout();
  const root = path.join(dir, 'projects');
  const repo = path.join(root, 'p');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const [gitPort, uiPort] = [await freePort(), await freePort()];
  mkdirSync(path.join(dir, 'data', 'serve'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({
    token: 'tok', port: gitPort, uiPort, tunnel: 'none', mdns: false, selfUrl: null, tunnelUrl: null,
    peers: [{ name: 'stalled', url: `http://127.0.0.1:${silent.address().port}/${marker}`, token: 't' }],
  }));
  writeFileSync(path.join(dir, 'data', 'registry.json'), JSON.stringify([{ name: 'p', path: repo, leader: false, peers: [] }]));

  const child = spawn(process.execPath, [path.join(dir, 'bin', 'code-share.js'), 'serve', '--port', String(gitPort), '--ui-port', String(uiPort), '--tunnel', 'none'], {
    env: { ...process.env, PROJECTS_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  try {
    await eventually(() => out.includes('Web UI:'), 15_000);
    assert.match(out, /Web UI:/);
    fetch(`http://127.0.0.1:${uiPort}/api/sync-status?project=p&remote=stalled`).catch(() => {});
    const running = await eventually(() => (/git-remote-http/.test(processesMatching(marker)) ? processesMatching(marker) : ''), 10_000);
    assert.match(running, /git-remote-http/, 'a fetch is in flight before the signal');

    const t = Date.now();
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    assert.ok(Date.now() - t < 3000, `serve took ${Date.now() - t}ms to exit`);
    assert.deepEqual({ code, signal }, { code: 0, signal: null });
    assert.equal(await eventually(() => processesMatching(marker) === '', 3000), true, processesMatching(marker));
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
