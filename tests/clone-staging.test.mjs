// A clone is staged beside its target and moved into place only when complete: concurrent clones of one name
// end with exactly one repo, nothing is left behind, a pre-existing target is never touched, and stale staging
// directories are swept and never listed as projects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { request, require } from './_backend.mjs';
import { SERVE_DIR, store } from './_isolatedData.mjs';

const { startServer } = require('../src/server');
const { startWebUI } = require('../src/webui');
const peer = require('../src/peer');
const { cloneRepo } = peer;
const fs = require('fs');
const { scanProjectsRoot } = require('../src/registry');
const { STAGING_PREFIX, STAGING_RE, sweepStaleStaging } = require('../src/clone-staging');

const ROOT = process.env.PROJECTS_ROOT;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const staged = () => readdirSync(ROOT).filter((n) => STAGING_RE.test(n));
// A pid no process has: a child that has already exited (and been reaped).
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

let peerServer;
let ui;
let sha;
before(async () => {
  // The peer: this test's own git server, serving one bare repo under several names.
  const work = path.join(ROOT, '..', 'peer-work');
  const bare = path.join(ROOT, '..', 'peer.git');
  mkdirSync(work);
  git(work, 'init', '-q');
  writeFileSync(path.join(work, 'README'), 'peer\n');
  git(work, 'add', 'README');
  git(work, 'commit', '-q', '-m', 'one');
  git(work, 'clone', '-q', '--bare', '.', bare);
  sha = git(bare, 'rev-parse', 'HEAD').trim();
  for (let i = 0; i < 5; i++) symlinkSync(bare, path.join(SERVE_DIR, `race${i}.git`));
  ({ server: peerServer } = await startServer(0, 'tok', '127.0.0.1'));
  ui = await startWebUI(0);
  store.config.peers = [{ name: 'self', url: `http://127.0.0.1:${peerServer.address().port}`, token: 'tok' }];
});
after(async () => {
  await Promise.all([peerServer, ui].map((s) => new Promise((r) => s.close(() => r()))));
});

const clone = (project) => request(`http://127.0.0.1:${ui.address().port}/api/clone`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peer: 'self', project }),
});

// Invariant: two concurrent /api/clone of one name end with exactly one success and one clean refusal, the target
// a complete repo at the peer's commit, registered once, and no staging directory left. Five pairs; at least one
// loser must have cloned alongside the winner and lost at the claim on the name (the route's existence check is
// earlier, and would hide a broken claim).
test('concurrent clones of one name: one repo, one clean failure, nothing left over', async () => {
  const refusals = [];
  for (let i = 0; i < 5; i++) {
    const name = `race${i}`;
    const results = await Promise.all([clone(name), clone(name)]);
    const ok = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status !== 200);
    assert.equal(ok.length, 1, results.map((r) => `${r.status} ${r.body}`).join(' | '));
    assert.match(JSON.parse(failed[0].body).error, /Destination already exists|Name already in use/);
    refusals.push(JSON.parse(failed[0].body).error);
    assert.equal(git(path.join(ROOT, name), 'rev-parse', 'HEAD').trim(), sha);
    assert.equal(git(path.join(ROOT, name), 'status', '--porcelain'), '');
    assert.equal(store.registry.filter((p) => p.name === name).length, 1);
    assert.deepEqual(staged(), []);
  }
  assert.ok(refusals.some((e) => /^Clone failed: Destination already exists/.test(e)), refusals.join(' | '));
});

// Invariant: a clone into a name that is already taken (here by a directory holding a file) never touches it,
// leaves no staging directory, and reports the name as taken.
test('a taken target is never touched', async () => {
  const taken = path.join(ROOT, 'taken');
  mkdirSync(taken);
  writeFileSync(path.join(taken, 'mine.txt'), 'keep\n');
  const url = `http://127.0.0.1:${peerServer.address().port}/race0.git`;
  await assert.rejects(cloneRepo(url, 'tok', taken), /already exists and is not an empty directory/);
  assert.deepEqual(readdirSync(taken), ['mine.txt']);
  assert.deepEqual(staged(), []);
});

// Invariant: a clone that fails (the peer has no such repo) leaves neither the target nor a staging directory.
test('a failed clone leaves nothing under the root', async () => {
  const url = `http://127.0.0.1:${peerServer.address().port}/missing.git`;
  await assert.rejects(cloneRepo(url, 'tok', path.join(ROOT, 'missing')));
  assert.equal(existsSync(path.join(ROOT, 'missing')), false);
  assert.deepEqual(staged(), []);
});

// Invariant: the startup sweep removes exactly the staging directories, directly inside the root, of processes that
// are no longer running; a running process's, this process's, look-alikes, files and nested ones are kept.
test('sweepStaleStaging removes only stale staging directories', async () => {
  const sweepRoot = path.join(ROOT, '..', 'sweep-root');
  mkdirSync(sweepRoot);
  const dead = deadPid();
  const running = spawn('sleep', ['30']);
  try {
    const stale = `${STAGING_PREFIX}${dead}-0a1b2c`;
    const kept = [
      `${STAGING_PREFIX}${running.pid}-0a1b2c`, // a running process's clone
      `${STAGING_PREFIX}${process.pid}-0a1b2c`, // this process's own
      `${STAGING_PREFIX}${dead}-xyz`, // not hex: not a staging name
      `${STAGING_PREFIX}${dead}`, // no random part
      `code-share-clone-${dead}-0a1b2c`, // no leading dot
      'alpha', // a project
    ];
    for (const n of [stale, ...kept]) mkdirSync(path.join(sweepRoot, n, '.git'), { recursive: true });
    writeFileSync(path.join(sweepRoot, `${STAGING_PREFIX}${dead}-ffff`), 'a file, not a directory');
    mkdirSync(path.join(sweepRoot, 'alpha', `${STAGING_PREFIX}${dead}-0a1b2c`)); // nested: not a direct child
    assert.deepEqual(sweepStaleStaging(sweepRoot), [path.join(sweepRoot, stale)]);
    assert.deepEqual(readdirSync(sweepRoot).sort(), [...kept, `${STAGING_PREFIX}${dead}-ffff`].sort());
    assert.ok(existsSync(path.join(sweepRoot, 'alpha', `${STAGING_PREFIX}${dead}-0a1b2c`)));
  } finally {
    running.kill();
  }
});

// Invariant: a staging directory (a clone in progress, already a git repo) is never listed as a project, by the
// scanner or by /api/projects.
test('a staging directory is never listed as a project', async () => {
  const stage = path.join(ROOT, `${STAGING_PREFIX}${process.pid}-c0ffee`);
  mkdirSync(path.join(stage, '.git'), { recursive: true });
  try {
    assert.ok(scanProjectsRoot().some((p) => p.name === 'race0'), 'positive control: a real clone is listed');
    assert.equal(scanProjectsRoot().some((p) => p.name.startsWith(STAGING_PREFIX)), false);
    const listed = JSON.parse((await request(`http://127.0.0.1:${ui.address().port}/api/projects`)).body);
    assert.equal(listed.some((p) => p.name.startsWith(STAGING_PREFIX)), false);
  } finally {
    execFileSync('rm', ['-rf', stage]);
  }
});

const peerUrl = (name) => `http://127.0.0.1:${peerServer.address().port}/${name}.git`;
const codeError = (code) => Object.assign(new Error(`${code}: rename failed`), { code });

/**
 * Runs `fn` with fs.renameSync replaced by `rename` (given the real one and a call log) and the platform set to
 * `platform`; restores both. Resolves the calls made.
 */
async function withRename(platform, rename, fn) {
  const real = fs.renameSync;
  const saved = peer._host.platform;
  const calls = [];
  fs.renameSync = (from, to) => { calls.push([from, to]); return rename(real, from, to); };
  peer._host.platform = platform;
  try {
    await fn();
  } finally {
    fs.renameSync = real;
    peer._host.platform = saved;
  }
  return calls;
}
// Windows rename semantics: never onto an existing directory, even an empty one.
const windowsRename = (real, from, to) => {
  if (existsSync(to)) throw codeError('EPERM');
  return real(from, to);
};

// Invariant (W1): on Windows, where rename refuses an existing (empty) directory with EPERM, the clone still lands:
// the empty claim is removed and the rename retried once; nothing is left behind.
test('win32: the clone lands although rename refuses the claimed directory', async () => {
  const target = path.join(ROOT, 'win-lands');
  const calls = await withRename('win32', windowsRename, () => cloneRepo(peerUrl('race0'), 'tok', target));
  assert.equal(calls.length, 2, 'refused once, then retried');
  assert.ok(calls.every(([, to]) => to === target));
  assert.equal(git(target, 'rev-parse', 'HEAD').trim(), sha);
  assert.equal(git(target, 'status', '--porcelain'), '');
  assert.deepEqual(staged(), []);
});

// Invariant (W1): the retry is Windows-only and only for EPERM/EEXIST. With the same refusal on POSIX, or another
// error on Windows, the clone fails once, with the claim and the staging directory removed.
test('the rename retry applies only to win32 EPERM/EEXIST', async () => {
  for (const [platform, rename, code] of [
    ['linux', windowsRename, 'EPERM'],
    ['win32', () => { throw codeError('ENOSPC'); }, 'ENOSPC'],
  ]) {
    const target = path.join(ROOT, `no-retry-${platform}`);
    let failure;
    const calls = await withRename(platform, rename, () => cloneRepo(peerUrl('race0'), 'tok', target).catch((e) => { failure = e; }));
    assert.equal(failure?.code, code, `${platform}: ${failure}`);
    assert.equal(calls.length, 1, `${platform}: no retry`);
    assert.equal(existsSync(target), false, `${platform}: the claim is removed`);
    assert.deepEqual(staged(), []);
  }
});

// Invariant (N3): a failed clone's error names the target asked for, never the staging directory git wrote into.
test('a failed clone names the target, not the staging directory', async () => {
  const target = path.join(ROOT, 'named');
  const failure = await cloneRepo(peerUrl('missing'), 'tok', target).catch((e) => e);
  assert.ok(failure instanceof Error);
  assert.ok(failure.message.includes(`Cloning into '${target}'`), failure.message);
  assert.equal(failure.message.includes(STAGING_PREFIX), false, failure.message);
});

// Invariant (N3): only exact staging names (STAGING_RE) are hidden: a user's repo whose name merely starts with
// the staging prefix is listed like any other project.
test('a repo named like the staging prefix is still listed', async () => {
  const name = `${STAGING_PREFIX}anything`;
  mkdirSync(path.join(ROOT, name));
  git(path.join(ROOT, name), 'init', '-q');
  assert.ok(scanProjectsRoot().some((p) => p.name === name));
  const listed = JSON.parse((await request(`http://127.0.0.1:${ui.address().port}/api/projects`)).body);
  assert.ok(listed.some((p) => p.name === name));
});

// Invariant (N2): a dangling symlink at the destination holds the name: /api/clone refuses with a 400 and leaves
// the link as it is.
test('/api/clone: a dangling symlink at the destination is a 400', async () => {
  const dest = path.join(ROOT, 'dangle');
  symlinkSync(path.join(ROOT, 'nowhere'), dest);
  const r = await clone('dangle');
  assert.equal(r.status, 400, r.body);
  assert.equal(JSON.parse(r.body).error, `Destination already exists: ${dest}`);
  assert.ok(lstatSync(dest).isSymbolicLink());
  assert.deepEqual(staged(), []);
});
