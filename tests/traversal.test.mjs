// Peer-supplied names and URLs never reach a path outside its root, a shell, or a git option.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { request, require } from './_backend.mjs';
import { SERVE_DIR, store } from './_isolatedData.mjs';

const names = require('../src/names');
const registry = require('../src/registry');
const peer = require('../src/peer');
const { sync, getSyncState } = require('../src/sync');
const { startWebUI } = require('../src/webui');
const { startServer } = require('../src/server');

const ROOT = process.env.PROJECTS_ROOT;
const PARENT = path.dirname(ROOT);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
const snapshot = () => ({ parent: readdirSync(PARENT).sort(), root: readdirSync(ROOT).sort() });

// A peer that is a directory of bare repos, reached by file: URL (no network).
const PEER_DIR = mkdtempSync(path.join(os.tmpdir(), 'code-share-peer-'));
function bareRepo(name, file = 'README', text = 'hello\n') {
  const work = mkdtempSync(path.join(os.tmpdir(), 'code-share-work-'));
  git(work, 'init', '-q');
  writeFileSync(path.join(work, file), text);
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(PEER_DIR, 'clone', '-q', '--bare', work, `${name}.git`);
  return work;
}

const BAD_PROJECT_NAMES = ['../x', '..', '.', 'a/b', 'a\\b', '.git', '-x', 'a\u0000b', 'a\nb', '\u007f', '/abs'];

// Invariant: a peer project name must be one plain path segment: no traversal, separators, leading "." or "-",
// or control characters; ordinary and odd-but-safe names pass.
test('checkProjectName refuses anything but one plain segment', () => {
  for (const n of [...BAD_PROJECT_NAMES, '', 42]) assert.throws(() => names.checkProjectName(n), /Invalid project name/, JSON.stringify(n));
  for (const n of ['delta', 'my project', '<img src=x onerror=alert(1)>', 'a.b-c_d']) assert.equal(names.checkProjectName(n), n);
});

// Invariant: childPath only returns a direct child of root: never root itself, its parent, or anything else.
test('childPath only returns a direct child', () => {
  assert.equal(names.childPath(ROOT, 'x'), path.join(ROOT, 'x'));
  for (const n of ['', '.', '..', '../x', 'a/b', '/etc']) assert.throws(() => names.childPath(ROOT, n), /outside/, n);
});

// Invariant: peer names are safe git remote names (no leading "-", no shell or path characters) and peer URLs are
// http(s) only.
test('checkPeerName and checkPeerUrl', () => {
  for (const n of ['-x', '--upload-pack=touch x', 'x"; touch y; "', '../a', 'a/b', 'a b', '', '.x', 'x.', 'x.lock', 'a..b', 'x'.repeat(65)]) {
    assert.throws(() => names.checkPeerName(n), /Invalid peer name/, n);
  }
  for (const n of ['peer', 'laptop-2', 'Alice.home', 'p_1']) assert.equal(names.checkPeerName(n), n);
  for (const u of ['file:///etc', 'ext::sh -c touch% x', 'ssh://h/x', 'not a url', '-u']) assert.throws(() => names.checkPeerUrl(u), /Invalid peer URL/, u);
  for (const u of ['http://10.0.0.7:9419', 'https://x.trycloudflare.com', 'http://x:tok@10.0.0.7:9419']) assert.equal(names.checkPeerUrl(u), u);
});

let ui;
let base;
before(async () => {
  store.config.peers = [{ name: 'peer', url: pathToFileURL(PEER_DIR).href, token: 'peer-token' }];
  ui = await startWebUI(0);
  base = `http://127.0.0.1:${ui.address().port}`;
});
after(() => new Promise((res) => ui.close(res)));
const clone = (project) => request(`${base}/api/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peer: 'peer', project }) });

// Invariant: /api/clone refuses every unsafe peer project name with a 400 naming the problem, before any git or
// filesystem work: nothing appears in PROJECTS_ROOT or beside it, and nothing is registered.
test('/api/clone refuses unsafe names and creates nothing', async () => {
  const before = snapshot();
  for (const n of BAD_PROJECT_NAMES) {
    const r = await clone(n);
    assert.equal(r.status, 400, JSON.stringify(n));
    assert.match(JSON.parse(r.body).error, /^Invalid project name/, JSON.stringify(n));
  }
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(store.registry, []);
  assert.deepEqual(readdirSync(SERVE_DIR), []);
});

// Invariant: a normal name still clones into PROJECTS_ROOT, is registered, served from SERVE_DIR and wired to the peer.
test('/api/clone clones a normal name from a local bare repo', async () => {
  bareRepo('delta', 'README', 'delta\n');
  const r = await clone('delta');
  assert.equal(r.status, 200, r.body);
  const dest = path.join(ROOT, 'delta');
  assert.ok(existsSync(path.join(dest, '.git')));
  assert.deepEqual(store.registry.map((p) => [p.name, p.path]), [['delta', dest]]);
  assert.equal(readlinkSync(path.join(SERVE_DIR, 'delta.git')), dest);
  assert.match(git(dest, 'remote', 'get-url', 'peer'), /delta\.git/);
});

// Invariant: the registry's served link always lands directly inside SERVE_DIR, from any caller; a local name with
// a leading "." is still allowed.
test('registry.addProject keeps the served link inside SERVE_DIR', () => {
  const repo = path.join(ROOT, 'local');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  const outside = path.join(path.dirname(SERVE_DIR), 'evil.git');
  for (const n of ['../evil', '../../evil', 'a/b', '', 'a\u0000b']) {
    assert.throws(() => registry.addProject(repo, n), /Invalid project name|outside/, JSON.stringify(n));
  }
  assert.equal(existsSync(outside), false);
  const e = registry.addProject(repo, '.dotfiles');
  assert.equal(e.name, '.dotfiles');
  assert.ok(lstatSync(path.join(SERVE_DIR, '.dotfiles.git')).isSymbolicLink());
  registry.removeProject('.dotfiles');
});

// Invariant: an unsafe peer name never reaches git as a remote name (where a leading "-" is an option), and connect
// refuses a bad name or a non-http(s) URL before any network call.
test('addRemote and connectPeer refuse unsafe names and URLs', async () => {
  const repo = path.join(ROOT, 'delta');
  for (const n of ['-x', '--mirror=push', 'x;y']) assert.throws(() => peer.addRemote(repo, n, 'http://h/x.git'), /Invalid peer name/, n);
  assert.doesNotMatch(git(repo, 'remote'), /mirror|-x/);
  await assert.rejects(peer.connectPeer('http://10.0.0.7:9419', 't', { name: '-x' }), /Invalid peer name/);
  await assert.rejects(peer.connectPeer('file:///etc', 't', { name: 'peer' }), /Invalid peer URL/);
});

// Invariant: a remote name never reaches a shell: an injection attempt is refused as a peer name and runs nothing.
test('sync and getSyncState refuse unsafe remote names without running them', async () => {
  const marker = path.join(PARENT, `pwned-${process.pid}`);
  for (const remote of [`x"; touch ${marker}; "`, `--upload-pack=touch ${marker}`, `$(touch ${marker})`]) {
    assert.throws(() => getSyncState('delta', { remote }), /Invalid peer name/, remote);
    await assert.rejects(sync('delta', { remote }), /Invalid peer name/, remote);
  }
  assert.equal(existsSync(marker), false);
});

// Invariant: argv-form sync still fetches, reports ahead/behind, merges, and on a conflict aborts cleanly listing
// the conflicting file.
test('sync in argv form: behind → merge → ahead; conflict aborts cleanly', async () => {
  const dest = path.join(ROOT, 'delta');
  const upstream = path.join(PEER_DIR, 'delta.git');
  const work = mkdtempSync(path.join(os.tmpdir(), 'code-share-up-'));
  git(work, 'clone', '-q', upstream, '.');
  writeFileSync(path.join(work, 'NEW'), 'x\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'p1'); git(work, 'push', '-q', 'origin', 'HEAD');
  assert.deepEqual(getSyncState('delta', { remote: 'peer' }), { project: 'delta', remote: 'peer', ahead: 0, behind: 1, state: 'remote-ahead' });
  const log = console.log; console.log = () => {};
  try {
    await sync('delta', { remote: 'peer' });
    assert.equal(getSyncState('delta', { remote: 'peer' }).state, 'local-ahead');
    writeFileSync(path.join(work, 'README'), 'peer side\n');
    git(work, 'commit', '-qam', 'p2'); git(work, 'push', '-q', 'origin', 'HEAD');
    writeFileSync(path.join(dest, 'README'), 'local side\n');
    git(dest, 'commit', '-qam', 'w2');
    await assert.rejects(sync('delta', { remote: 'peer' }), /Merge conflict\. Aborted cleanly\. Conflicting files:\n {2}README/);
    assert.equal(git(dest, 'status', '--porcelain'), '');
  } finally {
    console.log = log;
  }
});

// Invariant: /control/register refuses an unsafe peer name or a non-http(s) URL with a 400 and records nothing.
test('/control/register refuses unsafe names and URLs', async () => {
  const { server } = await startServer(0, 'tok', '127.0.0.1');
  const reg = (body) => request(`http://127.0.0.1:${server.address().port}/control/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Basic ${Buffer.from('x:tok').toString('base64')}` },
    body: JSON.stringify({ token: 't', ...body }),
  });
  try {
    const peersBefore = store.config.peers;
    for (const body of [{ name: '-x', url: 'http://h:1' }, { name: 'x"; touch y; "', url: 'http://h:1' }, { name: '../a', url: 'http://h:1' },
      { name: 'ok', url: 'file:///etc' }, { name: 'ok', url: 'ext::sh -c touch% x' }]) {
      const r = await reg(body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(store.config.peers, peersBefore);
    const ok = await reg({ name: 'laptop', url: 'http://10.0.0.7:9419' });
    assert.equal(ok.status, 200, ok.body);
    assert.ok(store.config.peers.some((p) => p.name === 'laptop'));
  } finally {
    await new Promise((res) => server.close(res));
  }
});

// Invariant: the git server routes only /<one segment>.git/{info/refs,git-upload-pack,HEAD}; a deeper path (a repo
// nested inside a shared project) is a 404 even with the token.
test('git server serves single-segment repo paths only', async () => {
  const { server } = await startServer(0, 'tok', '127.0.0.1');
  const auth = { authorization: `Basic ${Buffer.from('x:tok').toString('base64')}` };
  const at = (p) => request(`http://127.0.0.1:${server.address().port}${p}`, { headers: auth });
  try {
    const nested = path.join(ROOT, 'delta', 'inner');
    mkdirSync(nested);
    git(nested, 'init', '-q', '--bare');
    const ok = await at('/delta.git/info/refs?service=git-upload-pack');
    assert.equal(ok.status, 200);
    assert.equal(realpathSync(path.join(SERVE_DIR, 'delta.git')), path.join(ROOT, 'delta'));
    for (const p of ['/delta.git/inner/info/refs?service=git-upload-pack', '/delta.git/inner/HEAD', '/x.git/objects/info/packs']) {
      assert.equal((await at(p)).status, 404, p);
    }
  } finally {
    await new Promise((res) => server.close(res));
  }
});
