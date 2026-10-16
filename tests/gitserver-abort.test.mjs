// A client that aborts or garbles a request can never end the git server process or leak a git child.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { request, require } from './_backend.mjs';
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
after(() => new Promise((res) => server.close(res)));

// git-upload-pack children of this process (the servers run in it), by exact process name.
const gitChildren = () => execFileSync('sh', ['-c', `pgrep -a -P ${process.pid} -x git-upload-pack || true`], { encoding: 'utf8' }).trim();
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
    await wait(100);
  }
  assert.equal(gitChildren(), '');
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
    await wait(300);
  } finally {
    console.error = error;
  }
  assert.ok(logged.some((l) => /client connection error on POST \/r\.git\/git-upload-pack/.test(l)), logged.join('\n'));
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
