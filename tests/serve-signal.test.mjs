// Ending code-share ends the git commands it started, and removes the clones they were staging: git runs in its
// own process groups, which the signal to code-share does not reach, so code-share kills them itself, on SIGINT or
// SIGTERM (any command) and on a normal exit. Each test runs code-share as a child process from a scratch copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

const STAGING_PREFIX = '.code-share-clone-';
const held = new Set();
const silent = net.createServer((s) => { held.add(s); s.on('error', () => {}); });
before(() => new Promise((r) => silent.listen(0, '127.0.0.1', r)));
after(async () => {
  for (const s of held) s.destroy();
  await new Promise((r) => silent.close(() => r()));
});

const unique = (label) => `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
const stalledUrl = (marker) => `http://127.0.0.1:${silent.address().port}/${marker}`;
const helperFor = async (marker) => eventually(() => (/git-remote-http/.test(processesMatching(marker)) ? processesMatching(marker) : ''), 10_000);
const staged = (dir) => readdirSync(dir).filter((n) => n.startsWith(STAGING_PREFIX));

/** A scratch checkout whose config has one peer, `stalled`, that never answers, and a project `p` with it as a remote. */
function stalledFixture(marker) {
  const dir = scratchCheckout();
  const root = path.join(dir, 'projects');
  const repo = path.join(root, 'p');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'stalled', stalledUrl(marker)]);
  mkdirSync(path.join(dir, 'data', 'serve'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({
    token: 'tok', port: 1, uiPort: 1, tunnel: 'none', mdns: false, selfUrl: null, tunnelUrl: null,
    peers: [{ name: 'stalled', url: stalledUrl(marker), token: 't' }],
  }));
  writeFileSync(path.join(dir, 'data', 'registry.json'), JSON.stringify([{ name: 'p', path: repo, leader: false, peers: [] }]));
  return { dir, root };
}

/** Runs `code-share <args>` from the fixture, in `cwd`; resolves its exit once it ends. */
function codeShare({ dir, root }, args, cwd = root) {
  const child = spawn(process.execPath, [path.join(dir, 'bin', 'code-share.js'), ...args], {
    cwd, env: { ...process.env, PROJECTS_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return child;
}

// Invariant: SIGTERM to serve during a stalled fetch exits serve promptly (code 0) and leaves no git process for
// that peer behind. The in-flight check is the positive control.
test('SIGTERM to serve kills its in-flight git commands', async () => {
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
  // A clone staging directory left by a process that is gone: serve sweeps it when it starts.
  const stale = path.join(root, `${STAGING_PREFIX}${spawnSync(process.execPath, ['-e', '']).pid}-0a1b2c`);
  mkdirSync(path.join(stale, '.git'), { recursive: true });

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
    assert.equal(existsSync(stale), false, 'serve swept the stale staging directory');
    assert.ok(out.includes(`Removed stale clone staging directory ${stale}`), out);
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

// Invariant: SIGINT to a command other than serve (here `sync`, mid-fetch) kills its git process group before the
// command dies by the signal: no git process for that peer is left. The in-flight check is the positive control.
test('SIGINT to sync kills its in-flight fetch', async () => {
  const marker = unique('sync');
  const fx = stalledFixture(marker);
  const child = codeShare(fx, ['sync', 'p', '--remote', 'stalled']);
  try {
    assert.match(await helperFor(marker), /git-remote-http/, `a fetch is in flight before the signal\n${child.output}`);
    child.kill('SIGINT');
    assert.deepEqual(await child.exited, { code: null, signal: 'SIGINT' });
    assert.equal(await eventually(() => processesMatching(marker) === '', 3000), true, processesMatching(marker));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

// Invariant: SIGTERM to `clone` mid-clone kills git and removes the staging directory it was writing: nothing is
// left under the target's name or beside it. The staging check is the positive control.
test('SIGTERM to clone leaves nothing behind', async () => {
  const marker = unique('clone');
  const fx = stalledFixture(marker);
  const child = codeShare(fx, ['clone', 'stalled', 'delta']);
  try {
    assert.match(await helperFor(marker), /git-remote-http/);
    assert.equal(staged(fx.root).length, 1, 'git is writing into a staging directory');
    child.kill('SIGTERM');
    assert.deepEqual(await child.exited, { code: null, signal: 'SIGTERM' });
    assert.equal(await eventually(() => processesMatching(marker) === '', 3000), true, processesMatching(marker));
    assert.deepEqual(staged(fx.root), []);
    assert.equal(existsSync(path.join(fx.root, 'delta')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

// Invariant: a normal exit (process.exit, no signal) while git is still running kills it and removes the clone it
// was staging: the 'exit' hooks of src/git.js and src/clone-staging.js. Both commands are seen running first.
test('exiting with git still running kills it and removes its staging', async () => {
  const marker = unique('exit');
  const fx = stalledFixture(marker);
  const script = `
    const { runGit } = require('./src/git');
    const { cloneRepo } = require('./src/peer');
    runGit(['ls-remote', '--', process.argv[1] + '/a.git']);
    cloneRepo(process.argv[1] + '/b.git', 't', require('path').join(process.env.PROJECTS_ROOT, 'delta')).catch(() => {});
    process.stdin.once('data', () => process.exit(0));
  `;
  const child = spawn(process.execPath, ['-e', script, stalledUrl(marker)], {
    cwd: fx.dir, env: { ...process.env, PROJECTS_ROOT: fx.root }, stdio: ['pipe', 'ignore', 'inherit'],
  });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  try {
    const both = await eventually(() => (processesMatching(marker).split('\n').filter((l) => /git-remote-http/.test(l)).length >= 2), 10_000);
    assert.ok(both, `both git commands running\n${processesMatching(marker)}`);
    assert.equal(staged(fx.root).length, 1);
    child.stdin.write('exit\n');
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(await eventually(() => processesMatching(marker) === '', 3000), true, processesMatching(marker));
    assert.deepEqual(staged(fx.root), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
