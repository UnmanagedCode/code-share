'use strict';
// Every git command code-share runs: asynchronous (the event loop keeps
// serving both servers meanwhile), argv only (never a shell), with a deadline
// that kills the child, and no interactive credential prompt.
const { spawn } = require('child_process');
const { LIMITS } = require('./limits');

// The subcommand of an argv (skipping `-C <dir>` / `-c <cfg>` and other global options), for messages: the
// rest may carry a credential-bearing URL.
function subcommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  return args[i] || 'command';
}

/**
 * Runs `git <args>` in `cwd`. Resolves `{stdout, stderr, code}`; `code` is -1 when git could not start or
 * was killed at the deadline, with the reason in `stderr`. Never rejects.
 */
function runGit(args, { cwd, timeoutMs = LIMITS.GIT_TIMEOUT_MS } = {}) {
  const argv = ['-c', 'http.lowSpeedLimit=1', '-c', `http.lowSpeedTime=${LIMITS.GIT_STALL_SECONDS}`, ...args];
  // Its own process group (POSIX), so the deadline also kills the transport helpers git starts
  // (git-remote-http), which hold the output pipes open.
  const group = process.platform !== 'win32';
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn('git', argv, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: group,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (e) {
      resolve({ stdout: '', stderr: `Failed to run git: ${e.message}`, code: -1 });
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (group) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
      settle({ stdout, stderr: `git ${subcommand(args)} timed out after ${Math.round(timeoutMs / 1000)}s`, code: -1 });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (e) => settle({ stdout, stderr: `Failed to run git: ${e.message}`, code: -1 }));
    child.on('close', (code) => settle({ stdout, stderr, code: code ?? -1 }));
  });
}

module.exports = { runGit };
