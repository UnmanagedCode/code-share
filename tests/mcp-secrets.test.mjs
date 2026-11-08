// Security parity: no MCP reply exposes a secret that the previous status result did not.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { require } from './_backend.mjs';
import { store } from './_isolatedData.mjs';
import { call } from './_mcpCall.mjs';

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});

const { loadConfig, loadRegistry, PROJECTS_ROOT } = require('../src/config');
const tunnelManager = require('../src/tunnel-manager');
const syncMod = require('../src/sync');
const registry = require('../src/registry');

const OWN = 'OWN_SECRET_1', PEER_TOKEN = 'PEER_TOKEN_2', PEER_URLCRED = 'PEER_URLCRED_3', UNEXPOSED = 'UNEXPOSED_4';
const SENTINELS = [OWN, PEER_TOKEN, PEER_URLCRED, UNEXPOSED];
const found = (v) => SENTINELS.filter(s => (typeof v === 'string' ? v : JSON.stringify(v)).includes(s));

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'code-share-mcp-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
let n = 0;
function makeRepo() {
  const dir = path.join(ROOT, `r${++n}`);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const bobUrl = `https://x:${PEER_URLCRED}@bob.example`;
function scenarioA() {
  store.config = {
    token: UNEXPOSED, port: 9419, uiPort: 9420, tunnel: 'cloudflared', mdns: false,
    selfUrl: `http://x:${OWN}@10.0.0.1:9419`, tunnelUrl: `https://x:${OWN}@t.example`,
    peers: [{ name: 'bob', url: bobUrl, token: PEER_TOKEN }],
  };
  store.registry = [{ name: 'alpha', path: '/p/alpha', leader: false, peers: [{ name: 'bob', url: bobUrl, token: PEER_TOKEN, leader: true }] }];
}
beforeEach(() => {
  store.config = { token: UNEXPOSED, port: 9419, uiPort: 9420, tunnel: 'none', mdns: false, selfUrl: null, tunnelUrl: null, peers: [] };
  store.registry = [];
});

// A literal copy of the previous TOOLS.status result.
function legacyStatusResult() {
  const cfg = loadConfig();
  const reg = loadRegistry();
  const ts = tunnelManager.getTunnelStatus();
  return {
    selfUrl: cfg.selfUrl, tunnelUrl: cfg.tunnelUrl, port: cfg.port, uiPort: cfg.uiPort, tunnel: cfg.tunnel,
    tunnelStarting: ts.starting, projectsRoot: PROJECTS_ROOT, shared: reg, peers: cfg.peers || [],
  };
}

// Invariant: the secrets a status reply carries (either format) are a subset of what the previous result carried; the own token appears only via the URLs.
test('no reply exposes a secret that today\'s {result} does not', async () => {
  scenarioA();
  const legacy = found(legacyStatusResult());
  assert.deepEqual(legacy.sort(), [OWN, PEER_TOKEN, PEER_URLCRED].sort(), 'the baseline carries the three');
  for (const format of ['json', 'text']) {
    const r = await call('status', {}, format);
    for (const s of found(r)) assert.ok(legacy.includes(s), `${format} exposes ${s}`);
  }
  // Scenario B: nothing but the own `token` field holds the secret, and it was never in a reply.
  store.config = { ...store.config, selfUrl: null, tunnelUrl: null, peers: [], token: UNEXPOSED };
  store.registry = [{ name: 'alpha', path: '/p/alpha', leader: false, peers: [] }];
  for (const tool of ['status', 'share', 'sync']) {
    for (const format of ['json', 'text']) {
      const r = await call(tool, tool === 'share' ? { repoPath: '/nowhere' } : {}, format);
      assert.deepEqual(found(r), [], `${tool}/${format}`);
    }
  }
});

// Invariant: share and sync replies (success or refusal) and every refusal's details carry no secret.
test('share and sync replies and refusal details carry no secret', async () => {
  scenarioA();
  store.config.peers = [{ name: 'bob', url: 'http://127.0.0.1:9', token: PEER_TOKEN }];
  const upstream = makeRepo();
  const local = makeRepo();
  git(local, 'remote', 'add', 'peer', `http://x:${PEER_TOKEN}@127.0.0.1:9/alpha.git`);
  const replies = [];
  for (const format of ['json', 'text']) {
    replies.push(await call('share', { repoPath: makeRepo(), name: `s-${format}` }, format));
  }
  // refusals
  replies.push(await call('share', { repoPath: '/no/where' }, 'json'));
  replies.push(await call('share', { repoPath: local, name: 'a/b' }, 'json'));
  store.registry = [{ name: 'alpha', path: local, leader: false, peers: [{ name: 'peer', url: bobUrl, token: PEER_TOKEN, leader: false }] }];
  replies.push(await call('sync', {}, 'json'));              // FETCH_FAILED against the credentialed remote
  replies.push(await call('sync', {}, 'text'));
  replies.push(await call('sync', { project: 'zzz' }, 'json'));
  git(local, 'remote', 'set-url', 'peer', upstream);
  writeFileSync(path.join(upstream, 'u.txt'), 'u\n');
  git(upstream, 'add', '-A'); git(upstream, 'commit', '-q', '-m', 'up');
  for (const format of ['json', 'text']) replies.push(await call('sync', {}, format));
  for (const r of replies) {
    assert.deepEqual(found(r), [], JSON.stringify(r));
  }
  assert.ok(replies.some(r => r.code === 'FETCH_FAILED'));
  assert.ok(replies.some(r => 'structured' in r) && replies.some(r => 'text' in r));
  for (const r of replies) if (r.details) assert.deepEqual(found(r.details), []);
});

// Invariant: FETCH_FAILED's message is exactly what sync() throws, and PEER_WIRING_FAILED adds only the names to the underlying git message.
test('FETCH_FAILED and PEER_WIRING_FAILED messages add nothing to today\'s', async () => {
  const local = makeRepo();
  git(local, 'remote', 'add', 'peer', `http://x:${PEER_TOKEN}@127.0.0.1:9/alpha.git`);
  store.registry = [{ name: 'alpha', path: local, leader: false, peers: [] }];
  let direct;
  try { await syncMod.sync('alpha'); } catch (e) { direct = e.message; }
  const r = await call('sync', {}, 'json');
  assert.equal(r.code, 'FETCH_FAILED');
  assert.equal(r.error, direct);

  store.config.peers = [{ name: 'bob', url: 'http://127.0.0.1:9', token: PEER_TOKEN }];
  const repo = makeRepo();
  writeFileSync(path.join(repo, '.git', 'config.lock'), '');
  const w = await call('share', { repoPath: repo, name: 'wired' }, 'json');
  assert.equal(w.code, 'PEER_WIRING_FAILED');
  const peer = require('../src/peer');
  let gitMsg;
  try { await peer.wirePeerRemote('wired', repo, { name: 'bob', url: 'http://127.0.0.1:9', token: PEER_TOKEN }); } catch (e) { gitMsg = e.message; }
  assert.equal(w.error, `Shared wired, but wiring the git remote for peer "bob" failed: ${gitMsg}`);
  assert.ok(registry.findProject('wired'));
});
