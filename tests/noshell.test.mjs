// Values from peers and callers reach git only as argv elements: never through a shell, never as a refspec.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { request, require } from './_backend.mjs';
import { store } from './_isolatedData.mjs';

// Spy on spawn before src/git.js loads (it takes `spawn` when it loads).
const spawned = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = function (cmd, args, opts) {
  spawned.push({ cmd, args, opts });
  return realSpawn.call(this, cmd, args, opts);
};

const { sync, getSyncState } = require('../src/sync');
const { startWebUI } = require('../src/webui');

const ROOT = process.env.PROJECTS_ROOT;
const CWD = mkdtempSync(path.join(os.tmpdir(), 'code-share-cwd-'));
const PEER_DIR = mkdtempSync(path.join(os.tmpdir(), 'code-share-peer-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Names that pass every name guard but run a command under any `sh -c` form (they create a file named pwned).
const SHELL_PAYLOADS = ['p$(>pwned)', 'p`>pwned`'];
const pwnedAnywhere = () => [CWD, ROOT, PEER_DIR, path.dirname(ROOT)].filter((d) => readdirSync(d).includes('pwned'));

function bareRepo(name) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'code-share-work-'));
  git(work, 'init', '-q');
  writeFileSync(path.join(work, 'README'), 'x\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(PEER_DIR, 'clone', '-q', '--bare', work, `${name}.git`);
}

let ui;
let base;
before(async () => {
  process.chdir(CWD);
  store.config.peers = [{ name: 'peer', url: pathToFileURL(PEER_DIR).href, token: 't' }];
  ui = await startWebUI(0);
  base = `http://127.0.0.1:${ui.address().port}`;
});
after(() => new Promise((res) => ui.close(res)));

// Invariant: a clone whose name is shell-active (but a valid single segment) runs no shell: the clone succeeds and no
// `pwned` file appears in the working directory, the root, its parent or the peer.
test('clone of a shell-active project name runs no shell', async () => {
  for (const name of SHELL_PAYLOADS) {
    bareRepo(name);
    const r = await request(`${base}/api/clone`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ peer: 'peer', project: name }) });
    assert.equal(r.status, 200, `${name}: ${r.body}`);
    assert.ok(existsSync(path.join(ROOT, name, '.git')), name);
  }
  assert.deepEqual(pwnedAnywhere(), []);
});

// Invariant: every git command is spawn('git', <array>) without the shell option, and the remote and branch are
// single argv elements after `--`.
test('git runs as spawn("git", argv) with no shell', async () => {
  const dest = path.join(ROOT, SHELL_PAYLOADS[0]);
  store.registry = [{ name: 'shelly', path: dest, leader: false, peers: [] }];
  git(dest, 'remote', 'add', 'peer', path.join(PEER_DIR, `${SHELL_PAYLOADS[0]}.git`));
  spawned.length = 0;
  const log = console.log;
  console.log = () => {};
  try {
    await getSyncState('shelly', { remote: 'peer' });
    await sync('shelly', { remote: 'peer', branch: 'main' });
  } finally {
    console.log = log;
  }
  const gits = spawned.filter((s) => s.cmd === 'git');
  assert.ok(gits.length >= 4, `${gits.length} git spawns`);
  assert.equal(spawned.length, gits.length, 'nothing but git is spawned');
  for (const s of gits) {
    assert.ok(Array.isArray(s.args), 'argv array');
    assert.ok(!s.opts?.shell, 'no shell option');
  }
  const fetches = gits.map((s) => s.args.slice(s.args.indexOf('fetch'))).filter((a) => a[0] === 'fetch');
  assert.deepEqual(fetches, [['fetch', '--', 'peer'], ['fetch', '--', 'peer', 'main']]);
});

// Invariant: a branch that is not one plain ref (shell syntax, an option, a refspec, a range) is refused at the
// API boundary of POST /api/sync with a 400 (sync() refuses it too), and nothing runs.
test('POST /api/sync refuses an unsafe branch and runs nothing', async () => {
  const marker = path.join(CWD, 'pwned');
  spawned.length = 0;
  for (const branch of [`$(touch ${marker})`, '`>pwned`', '-x', '--upload-pack=x', '+main:refs/heads/main', 'main:x', 'a..b', 'a b', 'a@{1}']) {
    const r = await request(`${base}/api/sync`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ project: 'shelly', remote: 'peer', branch }) });
    assert.equal(r.status, 400, branch);
    assert.match(JSON.parse(r.body).error, /^Invalid branch/, branch);
  }
  assert.equal(spawned.length, 0, 'no git ran');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(pwnedAnywhere(), []);
});

// Invariant: sync() itself refuses an unsafe branch (the CLI and the MCP sync tool reach it directly).
test('sync() refuses an unsafe branch', async () => {
  spawned.length = 0;
  for (const branch of ['`>pwned`', '+main:refs/heads/main', '-x']) {
    await assert.rejects(sync('shelly', { remote: 'peer', branch }), /^Error: Invalid branch/, branch);
  }
  assert.equal(spawned.length, 0);
});
