'use strict';
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { loadRegistry } = require('./config');

function run(cmd, cwd, opts = {}) {
  const result = spawnSync('sh', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', code: result.status || 0 };
}

function getConflictingFiles(repoPath) {
  const r = run('git diff --name-only --diff-filter=U', repoPath);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

// Try to fetch the peer's current leader flag for this project from their live /control/status.
// Falls back to the value stored in the registry if the peer is unreachable.
function fetchPeerLeaderFlag(proj, remoteName) {
  const peerEntry = (proj.peers || []).find(p => p.name === remoteName);
  if (!peerEntry) return Promise.resolve(false);
  const stored = typeof peerEntry.leader === 'boolean' ? peerEntry.leader : false;

  return new Promise((resolve) => {
    try {
      const statusUrl = peerEntry.url.replace(/\/?$/, '') + '/control/status';
      const u = new URL(statusUrl);
      const opts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: '/control/status',
        method: 'GET',
        headers: { 'Authorization': `Basic ${Buffer.from(`x:${peerEntry.token}`).toString('base64')}` }
      };
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const ps = (data.shared || []).find(s => s.name === proj.name);
            resolve(typeof ps?.leader === 'boolean' ? ps.leader : stored);
          } catch {
            resolve(stored);
          }
        });
      });
      req.on('error', () => resolve(stored));
      req.setTimeout(5000, () => { req.destroy(); resolve(stored); });
      req.end();
    } catch {
      resolve(stored);
    }
  });
}

async function sync(projectName, opts = {}) {
  const { remote = 'peer', branch, useRebase = false } = opts;

  const reg = loadRegistry();
  let proj;
  if (projectName) {
    proj = reg.find(p => p.name === projectName);
    if (!proj) throw new Error(`Project not found in registry: ${projectName}`);
  } else if (reg.length === 1) {
    proj = reg[0];
  } else if (reg.length === 0) {
    throw new Error('No projects are shared. Use `share` to add one first.');
  } else {
    throw new Error(`Multiple projects found. Specify a project name: ${reg.map(p => p.name).join(', ')}`);
  }

  const repoPath = proj.path;
  const remoteBranch = branch || 'HEAD';

  // Step 1: fetch (pull-only — never pushes)
  console.log(`Fetching from ${remote}...`);
  const fetchResult = run(`git fetch "${remote}" ${remoteBranch}`, repoPath);
  if (fetchResult.code !== 0) {
    throw new Error(`git fetch failed:\n${fetchResult.stderr}`);
  }

  // Step 2: determine sync mode by comparing both sides' leader flags
  const myLeader   = proj.leader ?? false;
  const peerLeader = await fetchPeerLeaderFlag(proj, remote);
  // isFollower: I am not the leader and the peer is — fast-forward to their tip
  const isFollower = !myLeader && peerLeader;

  if (useRebase) {
    console.log('Rebasing onto FETCH_HEAD...');
    const r = run('git rebase FETCH_HEAD', repoPath);
    if (r.code !== 0) {
      const conflicts = getConflictingFiles(repoPath);
      run('git rebase --abort', repoPath);
      throw new Error(`Rebase conflict. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
    }
  } else if (isFollower) {
    // Fast-forward to leader's tip; rebase local commits on top if needed
    console.log('Follower fast-forward sync...');
    const ffResult = run('git merge --ff-only FETCH_HEAD', repoPath);
    if (ffResult.code !== 0) {
      console.log('Cannot fast-forward; rebasing local commits on top of leader tip...');
      const rebaseResult = run('git rebase FETCH_HEAD', repoPath);
      if (rebaseResult.code !== 0) {
        const conflicts = getConflictingFiles(repoPath);
        run('git rebase --abort', repoPath);
        throw new Error(`Rebase conflict on follower sync. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
      }
    }
  } else {
    // Symmetric (both same flag) or leader ingesting follower — merge --no-ff
    const label = (myLeader && !peerLeader) ? 'Leader ingesting follower' : 'Symmetric merge';
    console.log(`${label} (merge --no-ff)...`);
    const mergeResult = run('git merge --no-ff FETCH_HEAD -m "code-share: sync merge"', repoPath);
    if (mergeResult.code !== 0) {
      const conflicts = getConflictingFiles(repoPath);
      run('git merge --abort', repoPath);
      throw new Error(`Merge conflict. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
    }
  }

  console.log('Sync complete.');

  const log = run(`git log --oneline -3`, repoPath);
  if (log.stdout.trim()) {
    console.log('Recent commits:\n' + log.stdout.trim().split('\n').map(l => '  ' + l).join('\n'));
  }
}

// Read-only divergence check: fetches remote then counts ahead/behind commits.
// Does NOT touch the working tree or current branch.
function getSyncState(projectName, opts = {}) {
  const { remote = 'peer' } = opts;

  const reg = loadRegistry();
  const proj = reg.find(p => p.name === projectName);
  if (!proj) throw new Error(`Project not found in registry: ${projectName}`);

  const repoPath = proj.path;

  const fetchResult = run(`git fetch "${remote}"`, repoPath);
  if (fetchResult.code !== 0) {
    throw new Error(`git fetch failed: ${fetchResult.stderr.trim()}`);
  }

  const behindResult = run('git rev-list --count HEAD..FETCH_HEAD', repoPath);
  const aheadResult  = run('git rev-list --count FETCH_HEAD..HEAD', repoPath);
  const behind = parseInt(behindResult.stdout.trim(), 10) || 0;
  const ahead  = parseInt(aheadResult.stdout.trim(), 10)  || 0;

  let state = 'in-sync';
  if (ahead > 0 && behind > 0) state = 'diverged';
  else if (ahead > 0) state = 'local-ahead';
  else if (behind > 0) state = 'remote-ahead';

  return { project: projectName, remote, ahead, behind, state };
}

module.exports = { sync, getSyncState };
