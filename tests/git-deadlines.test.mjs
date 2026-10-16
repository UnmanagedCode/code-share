// Every git command is bounded: the deadline kills its whole process group, git's own stall abort fires on a
// trickling peer, a failed clone leaves nothing behind, and output is capped to its tail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eventually, processesMatching, request, require } from './_backend.mjs';
import { store } from './_isolatedData.mjs';

const { LIMITS } = require('../src/limits');
const { runGit } = require('../src/git');
const { cloneRepo } = require('../src/peer');
const { sync } = require('../src/sync');
const { startWebUI } = require('../src/webui');

const ROOT = process.env.PROJECTS_ROOT;
const DEFAULTS = { ...LIMITS };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
const unique = (label) => `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));

// A peer that accepts connections and never answers.
const held = new Set();
const silent = net.createServer((s) => { held.add(s); s.on('error', () => {}); });
// A peer that answers with headers, then sends nothing more.
const trickle = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
  res.flushHeaders();
});
let silentPort;
let tricklePort;
let ui;
before(async () => {
  silentPort = await listen(silent);
  tricklePort = await listen(trickle);
  ui = await startWebUI(0);
});
after(async () => {
  Object.assign(LIMITS, DEFAULTS);
  for (const s of held) s.destroy();
  trickle.closeAllConnections();
  await Promise.all([silent, trickle, ui].map((s) => new Promise((r) => s.close(() => r()))));
});

// Invariant: a git command killed at LIMITS.GIT_TIMEOUT_MS leaves no process behind: git and its transport helpers
// (git-remote-http) share a process group that is killed whole. The first check is the positive control.
test('the deadline kills git and its helpers', async () => {
  LIMITS.GIT_TIMEOUT_MS = 3000;
  const url = `http://127.0.0.1:${silentPort}/${unique('v3')}.git`;
  try {
    const pending = runGit(['ls-remote', '--', url]);
    const seen = await eventually(() => (/git-remote-http/.test(processesMatching(url)) ? processesMatching(url) : ''), 2500);
    assert.match(seen, /git-remote-http/, 'helper running before the deadline');
    const r = await pending;
    assert.equal(r.timedOut, true);
    assert.equal(r.code, -1);
    assert.match(r.stderr, /^git ls-remote timed out after 3s$/);
    assert.equal(await eventually(() => processesMatching(url) === '', 3000), true, processesMatching(url));
  } finally {
    LIMITS.GIT_TIMEOUT_MS = DEFAULTS.GIT_TIMEOUT_MS;
  }
});

// Invariant: git's own stall abort (LIMITS.GIT_STALL_SECONDS, passed as http.lowSpeedTime) ends a transfer that
// stopped moving, long before the outer deadline.
test('a stalled transfer fails on GIT_STALL_SECONDS, not the outer deadline', async () => {
  LIMITS.GIT_TIMEOUT_MS = 30_000;
  LIMITS.GIT_STALL_SECONDS = 1;
  try {
    const t = Date.now();
    const r = await runGit(['ls-remote', '--', `http://127.0.0.1:${tricklePort}/${unique('v5')}.git`]);
    const took = Date.now() - t;
    assert.equal(r.timedOut, false);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Operation too slow/);
    assert.ok(took < 10_000, `took ${took}ms`);
  } finally {
    LIMITS.GIT_TIMEOUT_MS = DEFAULTS.GIT_TIMEOUT_MS;
    LIMITS.GIT_STALL_SECONDS = DEFAULTS.GIT_STALL_SECONDS;
  }
});

// Invariant: a clone that fails (here, killed at the deadline) removes the directory git created, so a retry is not
// refused as "already exists". The in-flight check shows git did create it.
test('/api/clone: a timed-out clone leaves nothing behind and can be retried', async () => {
  LIMITS.GIT_TIMEOUT_MS = 1500;
  store.config.peers = [{ name: 'slow', url: `http://127.0.0.1:${silentPort}/${unique('r1')}`, token: 't' }];
  const clone = () => request(`http://127.0.0.1:${ui.address().port}/api/clone`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peer: 'slow', project: 'delta' }),
  });
  try {
    const pending = clone();
    assert.ok(await eventually(() => existsSync(path.join(ROOT, 'delta')), 1400), 'git created the destination while cloning');
    for (const r of [await pending, await clone()]) {
      assert.equal(r.status, 500, r.body);
      assert.match(JSON.parse(r.body).error, /^Clone failed: git clone timed out after 2s$/);
      assert.deepEqual(readdirSync(ROOT).filter((n) => n === 'delta'), []);
    }
    assert.deepEqual(store.registry, []);
  } finally {
    LIMITS.GIT_TIMEOUT_MS = DEFAULTS.GIT_TIMEOUT_MS;
  }
});

// Invariant: a failed clone never deletes a directory that existed before it started, empty (git would clone into
// it) or not.
test('cloneRepo never removes a pre-existing target', async () => {
  LIMITS.GIT_TIMEOUT_MS = 1000;
  const empty = mkdtempSync(path.join(os.tmpdir(), 'code-share-empty-'));
  const full = mkdtempSync(path.join(os.tmpdir(), 'code-share-full-'));
  writeFileSync(path.join(full, 'keep.txt'), 'mine\n');
  try {
    await assert.rejects(cloneRepo(`http://127.0.0.1:${silentPort}/${unique('pre')}.git`, 't', empty), /timed out/);
    await assert.rejects(cloneRepo(`http://127.0.0.1:${silentPort}/${unique('pre')}.git`, 't', full), /already exists and is not an empty directory/);
  } finally {
    LIMITS.GIT_TIMEOUT_MS = DEFAULTS.GIT_TIMEOUT_MS;
  }
  assert.ok(existsSync(empty));
  assert.deepEqual(readdirSync(full), ['keep.txt']);
});

// Invariant: git output is capped at LIMITS.GIT_OUTPUT_MAX_CHARS per stream, keeping the tail, where git reports
// its result and its errors.
test('git output keeps only its tail', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'code-share-log-'));
  git(repo, 'init', '-q');
  for (let i = 0; i < 40; i++) git(repo, 'commit', '-q', '--allow-empty', '-m', `commit-${String(i).padStart(2, '0')}`);
  LIMITS.GIT_OUTPUT_MAX_CHARS = 100;
  try {
    const log = await runGit(['log', '--format=%s'], { cwd: repo });
    assert.equal(log.code, 0);
    assert.ok(log.stdout.length <= 100, `${log.stdout.length} chars`);
    assert.ok(log.stdout.endsWith('commit-01\ncommit-00\n'), log.stdout);
    assert.doesNotMatch(log.stdout, /commit-39/);
    const bad = await runGit(['rev-parse', '--verify', `${'x'.repeat(400)}`], { cwd: repo });
    assert.ok(bad.stderr.length <= 100);
    assert.match(bad.stderr, /fatal: Needed a single revision\n$/);
  } finally {
    LIMITS.GIT_OUTPUT_MAX_CHARS = DEFAULTS.GIT_OUTPUT_MAX_CHARS;
  }
});

// Invariant: during sync, the peer's leader flag is read within LIMITS.LEADER_FLAG_TIMEOUT_MS (not the longer
// PEER_HTTP_TIMEOUT_MS); a stalled /control/status falls back to the stored flag (here leader → fast-forward).
test('sync: a stalled leader-flag lookup is bounded by LEADER_FLAG_TIMEOUT_MS', async () => {
  const upstream = path.join(mkdtempSync(path.join(os.tmpdir(), 'code-share-up-')), 'up.git');
  const work = mkdtempSync(path.join(os.tmpdir(), 'code-share-w-'));
  git(work, 'init', '-q');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, 'clone', '-q', '--bare', '.', upstream);
  const local = path.join(ROOT, 'leaderproj');
  git(ROOT, 'clone', '-q', upstream, local);
  git(local, 'remote', 'add', 'peer', upstream);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  git(work, 'push', '-q', upstream, 'HEAD:main');
  store.registry = [{ name: 'leaderproj', path: local, leader: false, peers: [{ name: 'peer', url: `http://127.0.0.1:${silentPort}`, token: 't', leader: true }] }];
  LIMITS.LEADER_FLAG_TIMEOUT_MS = 300;
  LIMITS.PEER_HTTP_TIMEOUT_MS = 60_000;
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const t = Date.now();
    await sync('leaderproj', { remote: 'peer' });
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t}ms`);
  } finally {
    console.log = log;
    LIMITS.LEADER_FLAG_TIMEOUT_MS = DEFAULTS.LEADER_FLAG_TIMEOUT_MS;
    LIMITS.PEER_HTTP_TIMEOUT_MS = DEFAULTS.PEER_HTTP_TIMEOUT_MS;
    store.registry = [];
  }
  assert.ok(lines.includes('Follower fast-forward sync...'), lines.join('\n'));
  assert.equal(git(local, 'log', '-1', '--format=%s').trim(), 'two');
});
