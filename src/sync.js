'use strict';
const { execSync, spawnSync } = require('child_process');
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

function sync(projectName, opts = {}) {
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

  // Step 2: integrate — strategy depends on role
  const role = proj.role; // null=symmetric, 'leader', 'follower'

  if (useRebase) {
    // Advanced opt-out: rebase
    console.log('Rebasing onto FETCH_HEAD...');
    const r = run('git rebase FETCH_HEAD', repoPath);
    if (r.code !== 0) {
      const conflicts = getConflictingFiles(repoPath);
      run('git rebase --abort', repoPath);
      throw new Error(`Rebase conflict. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
    }
  } else if (role === 'follower') {
    // Fast-forward to leader's tip; rebase local commits on top if needed
    console.log('Follower fast-forward sync...');
    const ffResult = run('git merge --ff-only FETCH_HEAD', repoPath);
    if (ffResult.code !== 0) {
      // Local commits exist — rebase them on top of leader
      console.log('Cannot fast-forward; rebasing local commits on top of leader tip...');
      const rebaseResult = run('git rebase FETCH_HEAD', repoPath);
      if (rebaseResult.code !== 0) {
        const conflicts = getConflictingFiles(repoPath);
        run('git rebase --abort', repoPath);
        throw new Error(`Rebase conflict on follower sync. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
      }
    }
  } else {
    // Symmetric (null) or leader ingesting follower: merge --no-ff
    const label = role === 'leader' ? 'Leader ingesting follower' : 'Symmetric merge';
    console.log(`${label} (merge --no-ff)...`);
    const mergeResult = run('git merge --no-ff FETCH_HEAD -m "code-share: sync merge"', repoPath);
    if (mergeResult.code !== 0) {
      const conflicts = getConflictingFiles(repoPath);
      run('git merge --abort', repoPath);
      throw new Error(`Merge conflict. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
    }
  }

  console.log('Sync complete.');

  // Show ahead/behind info
  const log = run(`git log --oneline -3`, repoPath);
  if (log.stdout.trim()) {
    console.log('Recent commits:\n' + log.stdout.trim().split('\n').map(l => '  ' + l).join('\n'));
  }
}

module.exports = { sync };
