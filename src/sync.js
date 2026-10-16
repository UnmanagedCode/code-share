'use strict';
const { loadRegistry } = require('./config');
const { checkPeerName, checkBranch } = require('./names');
const { runGit } = require('./git');
const { peerRequest } = require('./peer-http');
const { LIMITS } = require('./limits');

const git = (args, cwd) => runGit(args, { cwd });

async function getConflictingFiles(repoPath) {
  const r = await git(['diff', '--name-only', '--diff-filter=U'], repoPath);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

// Try to fetch the peer's current leader flag for this project from their live /control/status.
// Falls back to the value stored in the registry if the peer is unreachable or slow.
async function fetchPeerLeaderFlag(proj, remoteName) {
  const peerEntry = (proj.peers || []).find(p => p.name === remoteName);
  if (!peerEntry) return false;
  const stored = typeof peerEntry.leader === 'boolean' ? peerEntry.leader : false;
  try {
    const data = await peerRequest(peerEntry.url.replace(/\/?$/, '') + '/control/status', {
      token: peerEntry.token,
      timeoutMs: LIMITS.LEADER_FLAG_TIMEOUT_MS,
    });
    const ps = ((data && data.shared) || []).find(s => s.name === proj.name);
    return typeof ps?.leader === 'boolean' ? ps.leader : stored;
  } catch {
    return stored;
  }
}

async function sync(projectName, opts = {}) {
  const { remote = 'peer', branch, useRebase = false } = opts;
  checkPeerName(remote);
  if (branch) checkBranch(branch);

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
  const fetchResult = await git(['fetch', '--', remote, remoteBranch], repoPath);
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
    const r = await git(['rebase', 'FETCH_HEAD'], repoPath);
    if (r.code !== 0) {
      const conflicts = await getConflictingFiles(repoPath);
      await git(['rebase', '--abort'], repoPath);
      throw new Error(`Rebase conflict. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
    }
  } else if (isFollower) {
    // Fast-forward to leader's tip; rebase local commits on top if needed
    console.log('Follower fast-forward sync...');
    const ffResult = await git(['merge', '--ff-only', 'FETCH_HEAD'], repoPath);
    if (ffResult.code !== 0) {
      console.log('Cannot fast-forward; rebasing local commits on top of leader tip...');
      const rebaseResult = await git(['rebase', 'FETCH_HEAD'], repoPath);
      if (rebaseResult.code !== 0) {
        const conflicts = await getConflictingFiles(repoPath);
        await git(['rebase', '--abort'], repoPath);
        throw new Error(`Rebase conflict on follower sync. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
      }
    }
  } else {
    // Symmetric (both same flag) or leader ingesting follower — merge --no-ff
    const label = (myLeader && !peerLeader) ? 'Leader ingesting follower' : 'Symmetric merge';
    console.log(`${label} (merge --no-ff)...`);
    const mergeResult = await git(['merge', '--no-ff', '-m', 'code-share: sync merge', 'FETCH_HEAD'], repoPath);
    if (mergeResult.code !== 0) {
      const conflicts = await getConflictingFiles(repoPath);
      await git(['merge', '--abort'], repoPath);
      throw new Error(`Merge conflict. Aborted cleanly. Conflicting files:\n${conflicts.map(f => '  ' + f).join('\n') || '  (see git status for details)'}`);
    }
  }

  console.log('Sync complete.');

  const log = await git(['log', '--oneline', '-3'], repoPath);
  if (log.stdout.trim()) {
    console.log('Recent commits:\n' + log.stdout.trim().split('\n').map(l => '  ' + l).join('\n'));
  }

  return { project: proj.name };
}

// Read-only divergence check: fetches remote then counts ahead/behind commits.
// Does NOT touch the working tree or current branch.
async function getSyncState(projectName, opts = {}) {
  const { remote = 'peer' } = opts;
  checkPeerName(remote);

  const reg = loadRegistry();
  const proj = reg.find(p => p.name === projectName);
  if (!proj) throw new Error(`Project not found in registry: ${projectName}`);

  const repoPath = proj.path;

  const fetchResult = await git(['fetch', '--', remote], repoPath);
  if (fetchResult.code !== 0) {
    throw new Error(`git fetch failed: ${fetchResult.stderr.trim()}`);
  }

  const behindResult = await git(['rev-list', '--count', 'HEAD..FETCH_HEAD'], repoPath);
  const aheadResult  = await git(['rev-list', '--count', 'FETCH_HEAD..HEAD'], repoPath);
  const behind = parseInt(behindResult.stdout.trim(), 10) || 0;
  const ahead  = parseInt(aheadResult.stdout.trim(), 10)  || 0;

  let state = 'in-sync';
  if (ahead > 0 && behind > 0) state = 'diverged';
  else if (ahead > 0) state = 'local-ahead';
  else if (behind > 0) state = 'remote-ahead';

  return { project: projectName, remote, ahead, behind, state };
}

module.exports = { sync, getSyncState };
