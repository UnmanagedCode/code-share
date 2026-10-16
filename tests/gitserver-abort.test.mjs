// A client that aborts or garbles a request can never end the git server process or leak a git child.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { eventually, request, require } from './_backend.mjs';
import { SERVE_DIR } from './_isolatedData.mjs';

const { startServer } = require('../src/server');
const ROOT = process.env.PROJECTS_ROOT;
const AUTH = `Basic ${Buffer.from('x:tok').toString('base64')}`;
let server;
let port;
let sha;
before(async () => {
  const bare = path.join(ROOT, 'r.git');
  const work = path.join(ROOT, 'w');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  mkdirSync(work);
  execFileSync('git', ['init', '-q', work]);
  execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  execFileSync('git', ['-C', work, 'push', '-q', bare, 'HEAD:refs/heads/main']);
  sha = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  symlinkSync(bare, path.join(SERVE_DIR, 'r.git'));
  ({ server } = await startServer(0, 'tok', '127.0.0.1'));
  port = server.address().port;
});
// git-upload-pack children of this process (the servers run in it), by exact process name.
const gitChildren = () => execFileSync('sh', ['-c', `pgrep -a -P ${process.pid} -x git-upload-pack || true`], { encoding: 'utf8' }).trim();

// Kills any git-upload-pack child left over: a reaping regression then fails its assertion instead of holding
// this file's process (and the test run) open on the leaked child's pipes.
after(() => {
  execFileSync('sh', ['-c', `pkill -KILL -P ${process.pid} -x git-upload-pack || true`]);
  return new Promise((res) => server.close(res));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens a raw connection, writes `text`, and resets it after `ms`. */
function sendAndReset(text, ms) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(text);
      setTimeout(() => { s.resetAndDestroy(); resolve(); }, ms);
    });
    s.on('error', () => {});
  });
}

// Positive control for the leak check below: a git-upload-pack waiting on stdin is seen.
test('the leak check sees a waiting git-upload-pack', async () => {
  const child = spawn('git-upload-pack', ['--stateless-rpc', path.join(ROOT, 'r.git')], { stdio: ['pipe', 'ignore', 'ignore'] });
  await wait(200);
  try {
    assert.match(gitChildren(), /git-upload-pack --stateless-rpc/);
  } finally {
    child.kill('SIGKILL');
  }
  assert.ok(await eventually(() => gitChildren() === '', 3000), gitChildren());
});

// Invariant: resetting an authenticated upload-pack request mid-body (after git-upload-pack has started) is
// logged and survived: the server keeps answering, and no git-upload-pack child is left waiting.
test('a reset in-flight git request is survived without a leaked child', async () => {
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    for (let i = 0; i < 3; i++) {
      await sendAndReset(
        `POST /r.git/git-upload-pack HTTP/1.1\r\nHost: x\r\nAuthorization: ${AUTH}\r\n` +
        `Content-Type: application/x-git-upload-pack-request\r\nContent-Length: 100000\r\n\r\n0032want ${sha}\n`,
        300,
      );
    }
  } finally {
    console.error = error;
  }
  assert.ok(await eventually(() => gitChildren() === '', 5000), gitChildren());
  assert.ok(logged.some((l) => /client connection error on POST \/r\.git\/git-upload-pack/.test(l)), logged.join('\n'));
  // A hang-up is the client's, logged once as such: never reported as a git failure.
  assert.ok(logged.every((l) => /^Git server: client connection error on POST \/r\.git\/git-upload-pack: /.test(l)), logged.join('\n'));
  assert.equal(gitChildren(), '');
  assert.equal((await request(`http://127.0.0.1:${port}/connect`)).status !== 0, true);
  assert.equal((await request(`http://127.0.0.1:${port}/r.git/info/refs?service=git-upload-pack`, { headers: { authorization: AUTH } })).status, 200);
});

// Invariant: a malformed request gets a 400 and the server keeps answering.
test('a malformed request is a 400', async () => {
  const reply = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('NOT HTTP AT ALL\r\n\r\n'));
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
  });
  assert.match(reply, /^HTTP\/1\.1 400 Bad Request/);
  assert.equal((await request(`http://127.0.0.1:${port}/connect`)).status !== 0, true);
});

// Invariant: a client hanging up in the middle of a /control/register body is one log line, never a stack trace.
test('an aborted register body logs one line and no stack', async () => {
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' '));
  try {
    await sendAndReset(
      `POST /control/register HTTP/1.1\r\nHost: x\r\nAuthorization: ${AUTH}\r\nContent-Type: application/json\r\n` +
      'Content-Length: 1000\r\n\r\n{"url":"http://h:1",',
      200,
    );
    await wait(200);
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 1, logged.join('\n---\n'));
  assert.match(logged[0], /^Git server: client connection error on POST \/control\/register: aborted$/);
  assert.equal((await request(`http://127.0.0.1:${port}/connect`)).status !== 0, true);
});

// Invariant: when git-upload-pack cannot start (here: not on PATH; EMFILE and EAGAIN take the same path), both the ref
// advertisement and the upload-pack POST are a 500 with one log line each, and the server keeps serving. The
// positive control: with PATH restored, the same advertisement is a 200.
test('git-upload-pack failing to start is a 500, and the server stays up', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'code-share-nogit-'));
  symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  const logged = [];
  const error = console.error;
  const PATH = process.env.PATH;
  console.error = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' '));
  process.env.PATH = bin;
  let advert;
  let pack;
  try {
    advert = await request(`http://127.0.0.1:${port}/r.git/info/refs?service=git-upload-pack`, { headers: { authorization: AUTH } });
    pack = await request(`http://127.0.0.1:${port}/r.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: AUTH, 'Content-Type': 'application/x-git-upload-pack-request' },
      body: `0032want ${sha}\n00000009done\n`,
    });
  } finally {
    process.env.PATH = PATH;
    console.error = error;
  }
  assert.equal(advert.status, 500, advert.body);
  assert.equal(advert.body, 'git failed on the server\n');
  assert.equal(pack.status, 500, pack.body);
  assert.deepEqual(logged.map((l) => l.split(':')[0] + ':' + l.split(':')[1]), [
    'Git server: git-upload-pack --advertise-refs did not start',
    'Git server: git-upload-pack failed',
  ]);
  assert.ok(logged.every((l) => /ENOENT/.test(l) && !/\n\s+at /.test(l)), logged.join('\n'));
  assert.equal((await request(`http://127.0.0.1:${port}/connect`)).status !== 0, true);
  const again = await request(`http://127.0.0.1:${port}/r.git/info/refs?service=git-upload-pack`, { headers: { authorization: AUTH } });
  assert.equal(again.status, 200);
  assert.match(again.body, new RegExp(`^001e# service=git-upload-pack\n0000[0-9a-f]{4}${sha} `));
});
