// The three MCP tools through the dispatcher, in both formats, validated against the manifest outputSchemas.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { require } from './_backend.mjs';
import { store } from './_isolatedData.mjs';
import { call } from './_mcpCall.mjs';

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});

const syncMod = require('../src/sync');
const tunnelManager = require('../src/tunnel-manager');
const names = require('../src/names');
const registry = require('../src/registry');
const { CodedError } = require('../src/coded-error');
const { handle, TOOL_NAMES } = require('../src/mcp');
const { LIMITS } = require('../src/limits');

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'code-share-mcp-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
let counter = 0;
const fresh = (label) => path.join(ROOT, `${label}-${++counter}`);

/** A work repo with one commit holding `files` ({name: text}). */
function makeRepo(dir, files = { 'a.txt': 'base\n' }) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  commit(dir, files, 'base');
  return dir;
}
function commit(dir, files, msg) {
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(dir, f), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

/** upstream (work repo) + local (clone with remote `peer` -> upstream), registered as `alpha`. */
function syncFixture(files, regExtra = {}) {
  const upstream = makeRepo(fresh('upstream'), files);
  const local = fresh('local');
  git(ROOT, 'clone', '-q', upstream, local);
  git(local, 'remote', 'add', 'peer', upstream);
  store.registry = [{ name: 'alpha', path: local, leader: false, peers: [], ...regExtra }];
  return { upstream, local };
}

beforeEach(() => {
  store.config = { token: 'tok', port: 9419, uiPort: 9420, tunnel: 'cloudflared', mdns: false, selfUrl: null, tunnelUrl: null, peers: [] };
  store.registry = [];
});

const both = async (tool, args) => ({ json: await call(tool, args, 'json'), text: await call(tool, args, 'text') });

// ---- status ----

// Invariant: an empty store validates in both formats and the text says so.
test('status on an empty store', async () => {
  const { json, text } = await both('status', {});
  assert.deepEqual(json.structured.shared, []);
  assert.deepEqual(json.structured.peers, []);
  assert.match(text.text, /No projects are shared/);
  assert.match(text.text, /No peers are connected/);
});

// Invariant: every project, peer and per-project peer is in the json, and the text names each one.
test('status on a populated store', async () => {
  store.config.selfUrl = 'http://x:t@10.0.0.1:9419';
  store.config.peers = [{ name: 'bob', url: 'http://b:1', token: 'bt' }];
  store.registry = [
    { name: 'alpha', path: '/p/alpha', leader: true, peers: [{ name: 'bob', url: 'http://b:1', token: 'bt', leader: false }] },
    { name: 'beta', path: '/p/beta', leader: false, peers: [] },
  ];
  const { json, text } = await both('status', {});
  assert.equal(json.structured.shared.length, 2);
  assert.equal(json.structured.shared[0].peers[0].name, 'bob');
  for (const s of ['alpha', 'beta', '/p/alpha', 'bob', 'http://b:1', '10.0.0.1:9419', 'leader', 'follower', '(no peers wired)']) {
    assert.ok(text.text.includes(s), s);
  }
});

// Invariant: the oldest stored shapes still validate; `role` backfills `leader`, a missing `peers` is [].
test('status on the oldest stored shapes', async () => {
  store.registry = [
    { name: 'a', path: '/a', role: null, peers: [{ name: 'p1', url: 'http://p1', token: 't1', role: 'leader' }, { name: 'p2', url: 'http://p2', token: 't2' }] },
    { name: 'b', path: '/b', leader: true },
  ];
  store.config = { token: 't', port: 9419, tunnel: 'cloudflared', selfUrl: null, peers: [{ name: 'p1', url: 'http://p1', token: 't1', role: null }] };
  const { json } = await both('status', {});
  const s = json.structured;
  assert.deepEqual(s.shared.map(e => e.leader), [false, true]);
  assert.deepEqual(s.shared[0].peers.map(p => p.leader), [true, false]);
  assert.deepEqual(s.shared[1].peers, []);
  assert.equal(s.uiPort, null);
  assert.equal(s.tunnelUrl, null);
  assert.ok(!('role' in s.shared[0]) && !('role' in s.shared[0].peers[0]));
});

// Invariant: no list is capped in either view.
test('status returns 60 projects and 25 peers in full', async () => {
  store.registry = Array.from({ length: 60 }, (_, i) => ({ name: `proj${i}`, path: `/p/proj${i}`, leader: false, peers: [] }));
  store.config.peers = Array.from({ length: 25 }, (_, i) => ({ name: `peer${i}`, url: `http://h${i}:1`, token: `t${i}` }));
  const { json, text } = await both('status', {});
  assert.equal(json.structured.shared.length, 60);
  assert.equal(json.structured.peers.length, 25);
  for (let i = 0; i < 60; i++) assert.ok(text.text.includes(`proj${i} `), `proj${i}`);
  for (let i = 0; i < 25; i++) assert.ok(text.text.includes(`peer${i} `), `peer${i}`);
});

// ---- share ----

// Invariant: share with no peers reports the entry, and the text view says nothing was wired.
test('share succeeds with no peers', async () => {
  const repo = makeRepo(fresh('share'));
  const json = await call('share', { repoPath: repo, name: 'one', leader: true }, 'json');
  const text = await call('share', { repoPath: makeRepo(fresh('share')), name: 'one-b' }, 'text');
  assert.deepEqual(json.structured, { name: 'one', path: repo, leader: true, wiredPeers: [], skippedPeers: [] });
  assert.match(text.text, /Shared one-b \(follower\)/);
  assert.match(text.text, /No peers are connected/);
});

// Invariant: a connected peer's remote is wired locally (no network) and listed in wiredPeers.
test('share wires a connected peer', async () => {
  store.config.peers = [{ name: 'bob', url: 'http://127.0.0.1:9', token: 'bt' }];
  const repo = makeRepo(fresh('share'));
  const j = await call('share', { repoPath: repo, name: 'two' }, 'json');
  assert.deepEqual(j.structured.wiredPeers, ['bob']);
  assert.match(git(repo, 'remote'), /bob/);
  const repo2 = makeRepo(fresh('share'));
  const t = await call('share', { repoPath: repo2, name: 'three' }, 'text');
  assert.match(t.text, /Wired the git remote for peers: bob\./);
});

// Invariant: an unusable stored peer is reported in skippedPeers (null for a non-string name), never silently dropped.
test('share reports skipped peers', async () => {
  store.config.peers = [{ name: 'bad name', url: 'http://h:1', token: 't' }, { name: 42, url: 'http://h:1' }, { name: 'ok', url: 'ftp://h' }];
  const repo = makeRepo(fresh('share'));
  const j = await call('share', { repoPath: repo, name: 'four' }, 'json');
  assert.deepEqual(j.structured.skippedPeers, ['bad name', null, 'ok']);
  const repo2 = makeRepo(fresh('share'));
  const t = await call('share', { repoPath: repo2, name: 'five' }, 'text');
  assert.match(t.text, /Skipped unusable peer entries: bad name, \(unnamed\), ok;/);
});

// Invariant: each malformed argument is BAD_REQUEST naming it in details.argument.
test('share BAD_REQUEST per argument', async () => {
  for (const [args, argument] of [
    [{}, 'repoPath'], [{ repoPath: '' }, 'repoPath'], [{ repoPath: 5 }, 'repoPath'],
    [{ repoPath: '/x', name: 5 }, 'name'], [{ repoPath: '/x', leader: 'yes' }, 'leader'],
  ]) {
    const r = await call('share', args, 'json');
    assert.equal(r.code, 'BAD_REQUEST', JSON.stringify(args));
    assert.deepEqual(r.details, { argument });
  }
  assert.equal((await call('share', {}, 'json')).error, 'repoPath is required');
});

// Invariant: share refusals carry stable codes and the identifying details.
test('share refusals', async () => {
  const repo = makeRepo(fresh('share'));
  const bad = await call('share', { repoPath: repo, name: 'a/b' }, 'json');
  assert.equal(bad.code, 'INVALID_NAME');
  assert.deepEqual(bad.details, { argument: 'name' });

  const missing = path.join(ROOT, 'does-not-exist');
  const nf = await call('share', { repoPath: missing }, 'json');
  assert.equal(nf.code, 'NOT_FOUND');
  assert.deepEqual(nf.details, { path: missing });

  const plain = fresh('plain');
  mkdirSync(plain);
  const ng = await call('share', { repoPath: plain }, 'json');
  assert.equal(ng.code, 'NOT_A_GIT_REPO');
  assert.deepEqual(ng.details, { path: plain });

  assert.equal((await call('share', { repoPath: repo, name: 'dup' }, 'json')).code, undefined);
  const other = makeRepo(fresh('share'));
  const inUse = await call('share', { repoPath: other, name: 'dup' }, 'json');
  assert.equal(inUse.code, 'NAME_IN_USE');
  assert.deepEqual(inUse.details, { name: 'dup' });

  const already = await call('share', { repoPath: repo, name: 'again' }, 'json');
  assert.equal(already.code, 'ALREADY_SHARED');
  assert.deepEqual(already.details, { path: repo, name: 'dup' });
});

// Invariant: a git failure while wiring a valid peer is PEER_WIRING_FAILED, the project stays shared, and details name only names.
test('share PEER_WIRING_FAILED keeps the project shared', async () => {
  store.config.peers = [{ name: 'bob', url: 'http://127.0.0.1:9', token: 'bt' }];
  const repo = makeRepo(fresh('share'));
  writeFileSync(path.join(repo, '.git', 'config.lock'), ''); // git cannot lock its config: `remote add` really fails
  const r = await call('share', { repoPath: repo, name: 'six' }, 'json');
  assert.equal(r.code, 'PEER_WIRING_FAILED');
  assert.deepEqual(r.details, { name: 'six', path: repo, peer: 'bob', shared: true });
  assert.match(r.error, /^Shared six, but wiring the git remote for peer "bob" failed: /);
  assert.deepEqual(store.registry.map(p => p.name), ['six']);
});

// ---- sync ----

const states = (r) => [r.structured.mode, r.structured.state];

// Invariant: both sides diverged with equal flags merge symmetrically; the result is local-ahead.
test('sync symmetric-merge', async () => {
  const { upstream, local } = syncFixture();
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  commit(local, { 'l.txt': 'l\n' }, 'loc');
  const j = await call('sync', {}, 'json');
  assert.deepEqual(j.structured, { project: 'alpha', remote: 'peer', mode: 'symmetric-merge', ahead: 2, behind: 0, state: 'local-ahead' });
  assert.ok(existsSync(path.join(local, 'u.txt')));
  const t = await call('sync', { project: 'alpha' }, 'text');
  assert.match(t.text, /^Synced alpha from remote "peer" by symmetric merge \(merge --no-ff\)\. Now 2 ahead, 0 behind: the peer has not synced/);
});

// Invariant: a leader syncing a follower reports leader-ingest.
test('sync leader-ingest', async () => {
  const { upstream } = syncFixture(undefined, { leader: true });
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  const j = await call('sync', {}, 'json');
  assert.equal(j.structured.mode, 'leader-ingest');
});

// Invariant: a follower of a leader peer (stored flag, since the live lookup is refused) fast-forwards, in-sync after.
test('sync fast-forward', async () => {
  const { upstream } = syncFixture(undefined, { peers: [{ name: 'peer', url: 'http://127.0.0.1:9', token: 't', leader: true }] });
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  const j = await call('sync', {}, 'json');
  assert.deepEqual(states(j), ['fast-forward', 'in-sync']);
  const t = await call('sync', {}, 'text');
  assert.match(t.text, /by follower fast-forward to the leader's tip\. Now in sync \(0 ahead, 0 behind\)\./);
});

// Invariant: a follower that cannot fast-forward rebases and reports follower-rebase.
test('sync follower-rebase', async () => {
  const { upstream, local } = syncFixture(undefined, { peers: [{ name: 'peer', url: 'http://127.0.0.1:9', token: 't', leader: true }] });
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  commit(local, { 'l.txt': 'l\n' }, 'loc');
  const j = await call('sync', {}, 'json');
  assert.deepEqual(states(j), ['follower-rebase', 'local-ahead']);
});

// Invariant: useRebase selects rebase mode regardless of flags.
test('sync rebase', async () => {
  const { upstream, local } = syncFixture();
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  commit(local, { 'l.txt': 'l\n' }, 'loc');
  const j = await call('sync', { useRebase: true }, 'json');
  assert.deepEqual(j.structured, { project: 'alpha', remote: 'peer', mode: 'rebase', ahead: 1, behind: 0, state: 'local-ahead' });
  const t = await call('sync', { useRebase: true }, 'text');
  assert.match(t.text, /by rebase \(useRebase\)\./);
});

// Invariant: every state value validates and has its own sentence (the states a live sync cannot end in are injected).
test('sync renders each state', async () => {
  syncFixture();
  const saved = syncMod.getSyncState;
  try {
    const cases = [
      ['in-sync', 0, 0, /Now in sync \(0 ahead, 0 behind\)\./],
      ['local-ahead', 3, 0, /Now 3 ahead, 0 behind: the peer has not synced your commits yet\./],
      ['remote-ahead', 0, 4, /Now 0 ahead, 4 behind\./],
      ['diverged', 2, 5, /Now 2 ahead and 5 behind \(diverged\)\./],
    ];
    for (const [state, ahead, behind, re] of cases) {
      syncMod.getSyncState = async (project, { remote }) => ({ project, remote, ahead, behind, state });
      const j = await call('sync', {}, 'json');
      assert.deepEqual([j.structured.state, j.structured.ahead, j.structured.behind], [state, ahead, behind]);
      assert.match((await call('sync', {}, 'text')).text, re);
    }
  } finally {
    syncMod.getSyncState = saved;
  }
});

// Invariant: sync refusals carry stable codes and the identifying details.
test('sync refusals', async () => {
  store.registry = [];
  assert.equal((await call('sync', {}, 'json')).code, 'NOTHING_SHARED');

  store.registry = [{ name: 'a', path: '/a', leader: false, peers: [] }, { name: 'b', path: '/b', leader: false, peers: [] }];
  const multi = await call('sync', {}, 'json');
  assert.equal(multi.code, 'PROJECT_REQUIRED');
  assert.deepEqual(multi.details, { shared: ['a', 'b'] });
  assert.match(multi.error, /details\.shared/);

  const nf = await call('sync', { project: 'zzz' }, 'json');
  assert.equal(nf.code, 'NOT_FOUND');
  assert.deepEqual(nf.details, { project: 'zzz', shared: ['a', 'b'] });
});

// Invariant: a bad remote or branch is refused before git runs (the project path does not even exist).
test('sync INVALID_NAME and INVALID_BRANCH never reach git', async () => {
  store.registry = [{ name: 'a', path: path.join(ROOT, 'never-created'), leader: false, peers: [] }];
  const r = await call('sync', { remote: '-x' }, 'json');
  assert.equal(r.code, 'INVALID_NAME');
  assert.deepEqual(r.details, { argument: 'remote' });
  const b = await call('sync', { branch: '--upload-pack=x' }, 'json');
  assert.equal(b.code, 'INVALID_BRANCH');
  assert.deepEqual(b.details, { argument: 'branch' });
  for (const [args, argument] of [[{ project: 1 }, 'project'], [{ remote: 1 }, 'remote'], [{ branch: 1 }, 'branch'], [{ useRebase: 'y' }, 'useRebase']]) {
    const bad = await call('sync', args, 'json');
    assert.equal(bad.code, 'BAD_REQUEST');
    assert.deepEqual(bad.details, { argument });
  }
});

// Invariant: a failing fetch is FETCH_FAILED with only project and remote in details.
test('sync FETCH_FAILED', async () => {
  syncFixture();
  const r = await call('sync', { remote: 'nope' }, 'json');
  assert.equal(r.code, 'FETCH_FAILED');
  assert.deepEqual(r.details, { project: 'alpha', remote: 'nope' });
  assert.match(r.error, /^git fetch failed:/);
});

/** Both sides rewrite `n` shared files differently: a merge of the two conflicts in every one. */
function conflictFixture(n) {
  const names = Array.from({ length: n }, (_, i) => `dir/c${String(i).padStart(2, '0')}.txt`);
  const base = {};
  const upstream = fresh('upstream');
  mkdirSync(path.join(upstream, 'dir'), { recursive: true });
  for (const f of names) base[f] = 'base\n';
  makeRepo(upstream, base);
  const local = fresh('local');
  git(ROOT, 'clone', '-q', upstream, local);
  git(local, 'remote', 'add', 'peer', upstream);
  store.registry = [{ name: 'alpha', path: local, leader: false, peers: [] }];
  commit(upstream, Object.fromEntries(names.map(f => [f, 'upstream\n'])), 'up');
  commit(local, Object.fromEntries(names.map(f => [f, 'local\n'])), 'loc');
  return { names, local };
}

// Invariant: a conflict lists every file (no cap) in details, aborts cleanly, and keeps file names out of the message.
test('sync SYNC_CONFLICT lists all 30 files and aborts', async () => {
  const { names, local } = conflictFixture(30);
  const r = await call('sync', {}, 'json');
  assert.equal(r.code, 'SYNC_CONFLICT');
  assert.deepEqual(r.details.conflictingFiles, names);
  assert.equal(r.details.conflictingFilesTruncated, false);
  assert.equal(r.details.aborted, true);
  assert.equal(r.details.mode, 'symmetric-merge');
  assert.equal(r.details.project, 'alpha');
  assert.equal(r.details.remote, 'peer');
  assert.equal(git(local, 'status', '--porcelain'), '');
  assert.ok(!r.error.includes('c00'));
  assert.match(r.error, /^Merge conflict\. Aborted cleanly; 30 conflicting file\(s\) are listed in details\.conflictingFiles\.$/);
});

// Invariant: the git-output ceiling is kept and flagged; the cut never leaves a partial path in the list.
test('sync SYNC_CONFLICT flags the output ceiling', async () => {
  const { names } = conflictFixture(30);
  const saved = LIMITS.GIT_OUTPUT_MAX_CHARS;
  LIMITS.GIT_OUTPUT_MAX_CHARS = 100;
  try {
    const r = await call('sync', {}, 'json');
    assert.equal(r.code, 'SYNC_CONFLICT');
    assert.equal(r.details.conflictingFilesTruncated, true);
    assert.ok(r.details.conflictingFiles.length > 0 && r.details.conflictingFiles.length < 30);
    for (const f of r.details.conflictingFiles) assert.ok(names.includes(f), f);
  } finally {
    LIMITS.GIT_OUTPUT_MAX_CHARS = saved;
  }
});

// Invariant: the thrown messages the CLI and web UI read are today's text, with the truncation note only when cut.
test('sync() messages stay byte-identical', async () => {
  const { names } = conflictFixture(2);
  await assert.rejects(syncMod.sync('alpha'), (e) => e.message === `Merge conflict. Aborted cleanly. Conflicting files:\n${names.map(f => '  ' + f).join('\n')}`);
  await assert.rejects(syncMod.sync('alpha', { useRebase: true }), (e) => e.message.startsWith('Rebase conflict. Aborted cleanly. Conflicting files:\n  dir/c00.txt'));
  const saved = LIMITS.GIT_OUTPUT_MAX_CHARS;
  LIMITS.GIT_OUTPUT_MAX_CHARS = 14;
  try {
    await assert.rejects(syncMod.sync('alpha'), (e) => e.message.endsWith('\n  … (earlier conflicting files not shown)'));
  } finally {
    LIMITS.GIT_OUTPUT_MAX_CHARS = saved;
  }
  store.registry = [];
  await assert.rejects(syncMod.sync(), (e) => e.message === 'No projects are shared. Use `share` to add one first.');
});

// Invariant: a sync that succeeded but whose ahead/behind read failed is SYNC_STATE_UNAVAILABLE, flagged synced:true.
test('sync SYNC_STATE_UNAVAILABLE', async () => {
  const { upstream } = syncFixture();
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  const saved = syncMod.getSyncState;
  const { CodedError } = require('../src/coded-error');
  syncMod.getSyncState = async () => { throw new CodedError('FETCH_FAILED', 'git fetch failed: gone', { project: 'alpha', remote: 'peer' }); };
  try {
    const r = await call('sync', {}, 'json');
    assert.equal(r.code, 'SYNC_STATE_UNAVAILABLE');
    assert.deepEqual(r.details, { project: 'alpha', remote: 'peer', mode: 'symmetric-merge', synced: true });
    assert.match(r.error, /^Synced alpha \(symmetric-merge\), but reading the ahead\/behind state failed: git fetch failed: gone$/);
  } finally {
    syncMod.getSyncState = saved;
  }
});


// ---- review round 1 ----

/** Runs `fn` with tunnelManager.getTunnelStatus returning `status`. */
async function withTunnel(status, fn) {
  const saved = tunnelManager.getTunnelStatus;
  tunnelManager.getTunnelStatus = () => status;
  try { return await fn(); } finally { tunnelManager.getTunnelStatus = saved; }
}

// Invariant: status reports the stored port, uiPort, tunnel, tunnelUrl and the projects root as they are, in json and text.
test('status reports the stored config values', async () => {
  store.config = { ...store.config, port: 1111, uiPort: 2222, tunnel: 'localtunnel', selfUrl: 'http://x:t@10.9.8.7:1111', tunnelUrl: 'https://x:t@tun.example' };
  const { json, text } = await both('status', {});
  const s = json.structured;
  assert.deepEqual([s.port, s.uiPort, s.tunnel, s.tunnelUrl, s.selfUrl, s.tunnelStarting],
    [1111, 2222, 'localtunnel', 'https://x:t@tun.example', 'http://x:t@10.9.8.7:1111', false]);
  assert.equal(s.projectsRoot, process.env.PROJECTS_ROOT);
  assert.ok(text.text.includes(`Projects root: ${process.env.PROJECTS_ROOT}`));
  assert.ok(text.text.includes('Git server port 1111, web UI port 2222 (persisted). Tunnel (default localtunnel): running at https://x:t@tun.example.'));
  assert.ok(text.text.includes('LAN URL: http://x:t@10.9.8.7:1111'));
});

// Invariant: tunnelStarting follows the tunnel manager, and the text says "starting" only then.
test('status reports a starting tunnel', async () => {
  await withTunnel({ starting: true }, async () => {
    const { json, text } = await both('status', {});
    assert.equal(json.structured.tunnelStarting, true);
    assert.equal(json.structured.tunnelUrl, null);
    assert.match(text.text, /Tunnel \(default cloudflared\): starting\./);
  });
});

// Invariant: the text distinguishes a running tunnel (naming its URL), a starting one and none.
test('status text has a distinct line for each tunnel state', async () => {
  const line = async () => (await call('status', {}, 'text')).text.split('\n')[1];
  assert.match(await line(), /: not running\.$/);
  await withTunnel({ starting: true }, async () => assert.match(await line(), /: starting\.$/));
  store.config.tunnelUrl = 'https://x:t@run.example';
  assert.match(await line(), /: running at https:\/\/x:t@run\.example\.$/);
  await withTunnel({ starting: true }, async () => assert.match(await line(), /: running at /)); // a URL wins over "starting"
});

// Invariant: each peer's stored url and token are emitted at both levels (peers[] and shared[].peers[]), in json and text.
test('status emits peer url and token at both levels', async () => {
  store.config.peers = [{ name: 'bob', url: 'http://cfg.example:1', token: 'cfg-token' }];
  store.registry = [{ name: 'alpha', path: '/p/alpha', leader: false, peers: [{ name: 'bob', url: 'http://reg.example:2', token: 'reg-token', leader: true }] }];
  const { json, text } = await both('status', {});
  assert.deepEqual(json.structured.peers, [{ name: 'bob', url: 'http://cfg.example:1', token: 'cfg-token' }]);
  assert.deepEqual(json.structured.shared[0].peers, [{ name: 'bob', url: 'http://reg.example:2', token: 'reg-token', leader: true }]);
  assert.ok(text.text.includes('- bob — url http://cfg.example:1 — token cfg-token'));
  assert.ok(text.text.includes('  peer bob: leader, url http://reg.example:2, token reg-token'));
});

// Invariant: no nested list is capped: 15 peers on one project all appear in json and text.
test('status returns every peer of one project', async () => {
  const peers = Array.from({ length: 15 }, (_, i) => ({ name: `p${i}`, url: `http://h${i}:1`, token: `t${i}`, leader: false }));
  store.registry = [{ name: 'alpha', path: '/p/alpha', leader: false, peers }];
  const { json, text } = await both('status', {});
  assert.deepEqual(json.structured.shared[0].peers.map(p => p.name), peers.map(p => p.name));
  for (let i = 0; i < 15; i++) assert.ok(text.text.includes(`  peer p${i}: follower, url http://h${i}:1, token t${i}`), `p${i}`);
});

// Invariant: share lists every wired peer (3 here), in json, text and the repo's git remotes.
test('share wires and lists several connected peers', async () => {
  store.config.peers = ['b1', 'b2', 'b3'].map((name, i) => ({ name, url: `http://127.0.0.1:${9 - i}`, token: 't' }));
  const repo = makeRepo(fresh('share'));
  const j = await call('share', { repoPath: repo, name: 'multi' }, 'json');
  assert.deepEqual(j.structured.wiredPeers, ['b1', 'b2', 'b3']);
  assert.deepEqual(git(repo, 'remote').trim().split('\n'), ['b1', 'b2', 'b3']);
  const t = await call('share', { repoPath: makeRepo(fresh('share')), name: 'multi2' }, 'text');
  assert.match(t.text, /Wired the git remote for peers: b1, b2, b3\./);
});

// Invariant: sync uses the remote the caller names and reports it; ahead/behind are measured against that remote.
test('sync honours a caller-supplied remote', async () => {
  const { upstream, local } = syncFixture();
  const other = fresh('other');
  git(ROOT, 'clone', '-q', upstream, other);
  commit(other, { 'other.txt': 'o\n' }, 'from other');
  git(local, 'remote', 'add', 'up', other);
  const j = await call('sync', { remote: 'up' }, 'json');
  // The merge commit is the only commit `up` lacks; against `peer` (still at the base) it would be 2 ahead.
  assert.deepEqual(j.structured, { project: 'alpha', remote: 'up', mode: 'symmetric-merge', ahead: 1, behind: 0, state: 'local-ahead' });
  assert.ok(existsSync(path.join(local, 'other.txt')));
  const t = await call('sync', { remote: 'up' }, 'text');
  assert.match(t.text, /from remote "up" by /);
});

// Invariant: a valid `branch` is what gets fetched and integrated, not the remote's HEAD.
test('sync forwards a valid branch', async () => {
  const { upstream, local } = syncFixture();
  git(upstream, 'checkout', '-q', '-b', 'feature');
  commit(upstream, { 'feature.txt': 'f\n' }, 'feature work');
  git(upstream, 'checkout', '-q', 'main');
  commit(upstream, { 'main-only.txt': 'm\n' }, 'main work');
  const j = await call('sync', { branch: 'feature' }, 'json');
  assert.equal(j.structured.remote, 'peer');
  assert.ok(existsSync(path.join(local, 'feature.txt')));
  assert.ok(!existsSync(path.join(local, 'main-only.txt')));
});

// Invariant: share defaults the name to the directory basename and resolves a relative path to an absolute one.
test('share defaults and relative paths', async () => {
  const repo = makeRepo(fresh('relshare'));
  const rel = path.relative(process.cwd(), repo);
  assert.ok(!path.isAbsolute(rel));
  const j = await call('share', { repoPath: rel }, 'json');
  assert.equal(j.structured.name, path.basename(repo));
  assert.equal(j.structured.path, path.resolve(repo));
  assert.ok(path.isAbsolute(j.structured.path));
});

// Invariant: the sync text names each of the five modes with its own label.
test('sync text labels every mode', async () => {
  const labels = {
    rebase: 'rebase (useRebase)',
    'fast-forward': "follower fast-forward to the leader's tip",
    'follower-rebase': "follower rebase onto the leader's tip",
    'symmetric-merge': 'symmetric merge (merge --no-ff)',
    'leader-ingest': 'leader ingesting follower (merge --no-ff)',
  };
  const [savedSync, savedState] = [syncMod.sync, syncMod.getSyncState];
  try {
    for (const [mode, label] of Object.entries(labels)) {
      syncMod.sync = async () => ({ project: 'alpha', mode });
      syncMod.getSyncState = async (project, { remote }) => ({ project, remote, ahead: 0, behind: 0, state: 'in-sync' });
      const j = await call('sync', {}, 'json');
      assert.equal(j.structured.mode, mode);
      assert.ok((await call('sync', {}, 'text')).text.includes(` by ${label}. `), mode);
    }
  } finally {
    [syncMod.sync, syncMod.getSyncState] = [savedSync, savedState];
  }
});

// Invariant: SYNC_STATE_UNAVAILABLE wraps only FETCH_FAILED; any other coded error keeps its own code.
test('a non-fetch error from getSyncState propagates with its code', async () => {
  const { upstream } = syncFixture();
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  const saved = syncMod.getSyncState;
  syncMod.getSyncState = async () => { throw new CodedError('NOT_FOUND', 'Project not found in registry: alpha', { project: 'alpha', shared: [] }); };
  try {
    const r = await call('sync', {}, 'json');
    assert.equal(r.code, 'NOT_FOUND');
    assert.deepEqual(r.details, { project: 'alpha', shared: [] });
  } finally {
    syncMod.getSyncState = saved;
  }
});

// Invariant: with valid arguments every tool answers {text} when `format` is absent, and {structured} for json.
test('every tool answers a request without format with {text}', async () => {
  const { upstream } = syncFixture();
  commit(upstream, { 'u.txt': 'u\n' }, 'up');
  const argsFor = { status: {}, share: { repoPath: makeRepo(fresh('share')), name: 'nofmt' }, sync: { project: 'alpha' } };
  assert.deepEqual(Object.keys(argsFor).sort(), [...TOOL_NAMES].sort());
  for (const tool of TOOL_NAMES) {
    const body = { tool, arguments: argsFor[tool], caller: { sessionId: null, project: null } };
    const r = await handle(body);
    assert.deepEqual(Object.keys(r), ['text'], `${tool}: ${JSON.stringify(r).slice(0, 200)}`);
  }
});

// Invariant: checkPeerUrl refuses a non-URL and a non-http(s) URL with INVALID_URL.
test('checkPeerUrl raises INVALID_URL', () => {
  for (const url of ['not a url', 'ftp://h/x', 'file:///etc']) {
    assert.throws(() => names.checkPeerUrl(url), (e) => e instanceof CodedError && e.code === 'INVALID_URL');
  }
  assert.equal(names.checkPeerUrl('http://h:1'), 'http://h:1');
});

// Invariant: the messages the CLI and web UI read are unchanged by the added codes.
test('refusal messages stay byte-identical', async () => {
  const msg = async (fn) => { try { await fn(); } catch (e) { return e.message; } };
  store.registry = [{ name: 'a', path: '/a', leader: false, peers: [] }, { name: 'b', path: '/b', leader: false, peers: [] }];
  assert.equal(await msg(() => syncMod.sync('zzz')), 'Project not found in registry: zzz');
  assert.equal(await msg(() => syncMod.getSyncState('zzz')), 'Project not found in registry: zzz');
  assert.equal(await msg(() => syncMod.sync()), 'Multiple projects found. Specify a project name: a, b');
  const missing = path.join(ROOT, 'missing-dir');
  assert.equal(await msg(() => registry.addProject(missing, 'm')), `Path does not exist: ${missing}`);
  assert.equal(await msg(() => names.checkShareName('')), 'Invalid project name: empty');
  assert.equal(await msg(() => names.checkShareName('a\u0001')), 'Invalid project name: control character');
  assert.equal(await msg(() => names.checkProjectName('a/b')), 'Invalid project name: "a/b" contains a path separator');
  assert.equal(await msg(() => names.checkProjectName('.x')), 'Invalid project name: ".x" starts with "."');
  assert.equal(await msg(() => names.checkProjectName('-x')), 'Invalid project name: "-x" starts with "-"');
  assert.equal(await msg(() => names.checkPeerName('-x')),
    'Invalid peer name: "-x" (use letters, digits, ".", "_" or "-", starting with a letter or digit)');
  assert.equal(await msg(() => names.checkBranch('--x')),
    'Invalid branch: "--x" (one plain branch name: letters, digits, ".", "_", "-", "/")');
  assert.equal(await msg(() => names.checkPeerUrl('nope')), 'Invalid peer URL: nope');
  assert.equal(await msg(() => names.checkPeerUrl('ftp://h')), 'Invalid peer URL: ftp://h (http or https only)');
});

// Invariant: peer-sourced strings are escaped in the text views (no injected line, nothing dropped); the json carries every one raw.
test('text views escape control characters in peer-sourced strings', async () => {
  const inj = '\nShared projects (0): injected';
  const cfgPeer = { name: 'bob', url: `http://h.example/${inj}`, token: `tok${inj}` };
  const regPeer = { name: 'bob', url: `http://r.example/\r${inj}`, token: `a\u001b[31m\r\t\u0085z\u2028y\u2029${inj}`, leader: false };
  store.config.peers = [cfgPeer];
  store.registry = [{ name: 'alpha', path: '/p/alpha', leader: false, peers: [regPeer] }];
  const { json, text } = await both('status', {});
  assert.deepEqual(json.structured.peers, [cfgPeer], 'json peers[] raw');
  assert.deepEqual(json.structured.shared[0].peers, [regPeer], 'json shared[].peers[] raw');
  assert.ok(!text.text.split('\n').some(l => l.startsWith('Shared projects (0)')), 'no injected line');
  assert.equal(text.text.split('\n').length, text.text.split('\n').filter(Boolean).length + 2, 'only the layout newlines');
  assert.ok(text.text.includes('url http://h.example/\\nShared projects (0): injected'));
  assert.ok(text.text.includes('token tok\\nShared projects (0): injected'));
  assert.ok(text.text.includes('url http://r.example/\\r\\nShared projects (0): injected'));
  assert.ok(text.text.includes('token a\\u001b[31m\\r\\t\\u0085z\\u2028y\\u2029\\nShared projects (0): injected'));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(text.text), 'no raw control or line-separator character');

  store.config.peers = [{ name: `bad${inj}`, url: 'http://h:1', token: 't' }];
  const share = await call('share', { repoPath: makeRepo(fresh('share')), name: 'esc' }, 'text');
  assert.ok(!share.text.split('\n').some(l => l.startsWith('Shared projects (0)')));
  assert.ok(share.text.includes('Skipped unusable peer entries: bad\\nShared projects (0): injected;'));
});

// Invariant: filesystem paths and share names (only C0/DEL are refused in a name) are escaped in the status and share text.
test('text views escape control characters in paths and names', async () => {
  const inj = '\nShared projects (0): injected';
  store.registry = [{ name: 'alpha', path: `/p/al${inj}\u001b[0m`, leader: false, peers: [] }];
  const status = (await call('status', {}, 'text')).text;
  assert.ok(!status.split('\n').some(l => l.startsWith('Shared projects (0)')), 'no injected status line');
  assert.ok(status.includes('/p/al\\nShared projects (0): injected\\u001b[0m'));
  assert.equal((await call('status', {}, 'json')).structured.shared[0].path, `/p/al${inj}\u001b[0m`, 'json raw');

  store.registry = [];
  const dir = makeRepo(path.join(fresh('esc'), `real\nrepo\u001b`));
  const name = 'n\u0085m\u2028e';
  const share = (await call('share', { repoPath: dir, name }, 'text')).text;
  assert.ok(!share.split('\n').some(l => l.startsWith('repo')), 'the directory name starts no line');
  assert.equal(share.split('\n').length, 2, 'only the layout newline');
  assert.ok(share.startsWith('Shared n\\u0085m\\u2028e (follower) from '));
  assert.ok(share.includes('real\\nrepo\\u001b'));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(share));
});
