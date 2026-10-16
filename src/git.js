'use strict';
// Every git command code-share runs: asynchronous (the event loop keeps
// serving both servers meanwhile), argv only (never a shell), with a deadline
// that kills the child, bounded output, and no interactive credential prompt.
const { spawn } = require('child_process');
const { LIMITS } = require('./limits');

// Its own process group (POSIX), so the deadline also kills the transport helpers git starts
// (git-remote-http), which hold the output pipes open.
const GROUPS = process.platform !== 'win32';
// Process groups of git commands still running; killed when this process exits, since a separate
// group does not receive the signal that ends code-share.
const live = new Set();

function killGroup(pid) {
  try {
    if (GROUPS) process.kill(-pid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch { /* ESRCH: already gone */ }
}

/** Kills every git command still running. Safe to call more than once and from an 'exit' handler. */
function killAllGit() {
  for (const pid of live) killGroup(pid);
  live.clear();
}
process.on('exit', killAllGit);

// The subcommand of an argv (skipping `-C <dir>` / `-c <cfg>` and other global options), for messages: the
// rest may carry a credential-bearing URL.
function subcommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  return args[i] || 'command';
}

// The last `max` characters of `text + more`: git puts its error (and a conflict listing) at the end.
const tail = (text, more, max) => {
  const s = text + more;
  return s.length > max ? s.slice(s.length - max) : s;
};

/**
 * Runs `git <args>` in `cwd`. Resolves `{stdout, stderr, code, timedOut}`; `code` is -1 when git could not
 * start or was killed at the deadline (`timedOut: true`), with the reason in `stderr`. Each stream keeps at
 * most LIMITS.GIT_OUTPUT_MAX_CHARS, the tail. Never rejects.
 */
function runGit(args, { cwd, timeoutMs = LIMITS.GIT_TIMEOUT_MS } = {}) {
  const argv = ['-c', 'http.lowSpeedLimit=1', '-c', `http.lowSpeedTime=${LIMITS.GIT_STALL_SECONDS}`, ...args];
  const max = LIMITS.GIT_OUTPUT_MAX_CHARS;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn('git', argv, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: GROUPS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (e) {
      resolve({ stdout: '', stderr: `Failed to run git: ${e.message}`, code: -1, timedOut: false });
      return;
    }
    if (child.pid) live.add(child.pid);
    let settled = false;
    let grace;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      live.delete(child.pid);
      resolve(result);
    };
    const timedOutResult = () => ({ stdout, stderr: `git ${subcommand(args)} timed out after ${Math.round(timeoutMs / 1000)}s`, code: -1, timedOut: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      // Settle once git has exited (so nothing writes after the caller cleans up), or soon regardless.
      grace = setTimeout(() => settle(timedOutResult()), 2000);
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout = tail(stdout, d, max); });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = tail(stderr, d, max); });
    child.on('error', (e) => settle({ stdout, stderr: `Failed to run git: ${e.message}`, code: -1, timedOut: false }));
    child.on('exit', () => {
      live.delete(child.pid);
      if (timedOut) settle(timedOutResult());
    });
    child.on('close', (code) => settle(timedOut ? timedOutResult() : { stdout, stderr, code: code ?? -1, timedOut: false }));
  });
}

module.exports = { runGit, killAllGit };
