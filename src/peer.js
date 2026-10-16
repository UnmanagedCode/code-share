'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, loadRegistry, saveRegistry } = require('./config');
const registry = require('./registry');
const { isServing, isInternetUrl } = require('./serve-state');
const { checkPeerName, checkPeerUrl } = require('./names');
const { runGit } = require('./git');
const { peerRequest } = require('./peer-http');

function authedUrl(base, token) {
  const u = new URL(base);
  u.username = 'x';
  u.password = token;
  return u.toString();
}

// Build a cs1: connection string from a base URL + token (mirrors the web UI's
// makeConnectionString in frontend/src/lib/connectionString.ts; both are pinned
// to frontend/src/test/cs1-vector.json). Strips any embedded credentials and
// base64url-encodes a {url, token} payload as UTF-8. Returns null if url is missing/invalid.
function buildConnectionString(base, token) {
  if (!base) return null;
  try {
    const u = new URL(base);
    u.username = '';
    u.password = '';
    const bare = u.toString().replace(/\/$/, '');
    const json = JSON.stringify({ url: bare, token });
    return 'cs1:' + Buffer.from(json, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  } catch {
    return null;
  }
}

// Git runs through runGit (src/git.js): argv only, with `--` before positional
// arguments, so credential-bearing URLs, paths and peer-supplied names are
// never parsed by a shell or read as options.
// git clone creates the target before it reaches the peer, and a clone killed at
// the deadline cleans nothing up; a leftover directory would block the name
// for good. So a failed clone removes the target, but only one it created.
async function cloneRepo(url, token, dir) {
  const cloneUrl = token ? authedUrl(url, token) : url;
  const target = path.resolve(dir || '.');
  const existed = exists(target);
  const r = await runGit(['clone', '--', cloneUrl, target]);
  if (r.code !== 0) {
    if (!existed && exists(target)) fs.rmSync(target, { recursive: true, force: true });
    throw new Error((r.stderr || '').trim() || `git clone failed with status ${r.code}`);
  }
}

// Whether anything (a dangling symlink included) is at `p`.
function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function addRemote(repoPath, name, url) {
  checkPeerName(name);
  const add = await runGit(['-C', repoPath, 'remote', 'add', '--', name, url]);
  if (add.code === 0) return;
  // Fall back to set-url only when the remote actually exists; surface every
  // other git failure with its real stderr instead of swallowing it.
  if (/already exists/i.test(add.stderr)) {
    const set = await runGit(['-C', repoPath, 'remote', 'set-url', '--', name, url]);
    if (set.code !== 0) {
      throw new Error((set.stderr || '').trim() || `git remote set-url failed with status ${set.code}`);
    }
    return;
  }
  throw new Error((add.stderr || '').trim() || `git remote add failed with status ${add.code}`);
}

// Wire one peer's git remote + registry peer entry onto a project. Idempotent
// (addRemote does add → set-url). `pr` is a peer config entry { name, url, token }.
// Returns { name, url } (the project's URL on that peer) for caller-side logging.
async function wirePeerRemote(projectName, repoPath, pr) {
  const projUrl = pr.url.replace(/\/?$/, '') + '/' + projectName + '.git';
  await addRemote(repoPath, pr.name, authedUrl(projUrl, pr.token));
  registry.addPeerToProject(projectName, { name: pr.name, url: pr.url, token: pr.token, leader: false });
  return { name: pr.name, url: projUrl };
}

// Wire every currently-connected peer onto a project. Shared by the CLI `share`
// command and the web UI's /api/share and /api/clone so the peer association is
// populated consistently no matter which path shares a project.
// A stored peer entry that cannot be wired (a name outside PEER_NAME_RE, a
// non-http(s) URL) is skipped with a logged error, so one bad entry never
// blocks sharing.
// Returns the list of wired peers ([{ name, url }]) for caller-side logging.
async function wireConnectedPeers(projectName, repoPath) {
  const cfg = loadConfig();
  const wired = [];
  for (const pr of cfg.peers || []) {
    try {
      checkPeerName(pr.name);
      checkPeerUrl(pr.url);
    } catch (e) {
      // console.error, never process.stderr.write: see the note in connectPeer.
      console.error(`Skipping peer ${JSON.stringify(pr.name)} for ${projectName}: ${e.message}`);
      continue;
    }
    wired.push(await wirePeerRemote(projectName, repoPath, pr));
  }
  return wired;
}

async function connectPeer(peerBaseUrl, peerToken, opts = {}) {
  const { name = 'peer' } = opts;
  checkPeerName(name);
  checkPeerUrl(peerBaseUrl);
  const cfg = loadConfig();

  if (!(await isServing(cfg.port))) {
    throw new Error(
      'serve is not running — start it first with `serve` ' +
      '(use `--tunnel cloudflared` to be reachable over the internet)'
    );
  }

  if (isInternetUrl(peerBaseUrl) && !cfg.tunnelUrl) {
    throw new Error(
      'This peer is reachable over the internet, but your serve has no tunnel. ' +
      'Restart with `serve --tunnel cloudflared` so you have a reachable URL to advertise back.'
    );
  }

  const selfToken = cfg.token;
  const selfUrl = cfg.tunnelUrl || cfg.selfUrl;

  if (!selfUrl) {
    throw new Error('No selfUrl set — run `serve` first so your URL is known before connecting');
  }

  // Build per-project leaders map from our current registry
  const reg = loadRegistry();
  const projectLeaders = {};
  for (const proj of reg) {
    projectLeaders[proj.name] = proj.leader ?? false;
  }

  // POST our info to peer's control endpoint
  const registerUrl = peerBaseUrl.replace(/\/?$/, '') + '/control/register';
  let peerResp;
  try {
    peerResp = await peerRequest(registerUrl, {
      method: 'POST',
      body: { url: selfUrl, token: selfToken, name, projectLeaders },
      token: peerToken,
    });
  } catch (e) {
    throw new Error(`Failed to reach peer at ${registerUrl}: ${e.message}`);
  }

  // Fetch peer's current project leader flags so we can store them
  let peerLeaders = {};
  try {
    const statusUrl = peerBaseUrl.replace(/\/?$/, '') + '/control/status';
    const peerStatus = await peerRequest(statusUrl, { token: peerToken });
    for (const s of (peerStatus.shared || [])) {
      peerLeaders[s.name] = s.leader ?? false;
    }
  } catch {
    // peer status unreachable; peerEntry.leader defaults to false
  }

  // Add peer to all shared projects in registry. Wire the git remote first and
  // only record the peer entry on a project once its remote actually exists, so
  // a broken/stale project (e.g. its dir is gone or not a git repo) is logged
  // and skipped instead of claiming a remote that isn't there.
  for (const proj of reg) {
    const authedPeerUrl = authedUrl(peerBaseUrl.replace(/\/?$/, '') + '/' + proj.name + '.git', peerToken);
    try {
      await addRemote(proj.path, name, authedPeerUrl);
    } catch (e) {
      // NOTE: console.error is deliberate — on a server whose stdio is an
      // orphaned socketpair (dead parent), Node's Console drops the bytes on
      // EPIPE (ignoreErrors default). Do NOT "improve" this to a raw
      // process.stderr.write(...): that would raise EPIPE unhandled and crash.
      console.error(`Failed to wire remote '${name}' on ${proj.name}: ${e.message}`);
      continue;
    }
    const pe = { name, url: peerBaseUrl, token: peerToken, leader: peerLeaders[proj.name] ?? false };
    const existingPeer = proj.peers.findIndex(p => p.name === name);
    if (existingPeer >= 0) proj.peers[existingPeer] = pe;
    else proj.peers.push(pe);
  }
  saveRegistry(reg);

  // Persist the peer in our instance config only after the registry wiring is
  // done, so a failed connect can't leave config.peers claiming a connection
  // whose remotes were never wired. Re-read fresh rather than reusing the `cfg`
  // snapshot from before the network round-trips above — another request (e.g.
  // a runtime tunnel start/stop) may have written config.json meanwhile, and
  // saving the stale snapshot here would silently revert that write.
  const fresh = loadConfig();
  const peers = fresh.peers || [];
  const existingIdx = peers.findIndex(p => p.name === name);
  const peerEntry = { name, url: peerBaseUrl, token: peerToken };
  if (existingIdx >= 0) peers[existingIdx] = peerEntry;
  else peers.push(peerEntry);
  fresh.peers = peers;
  saveConfig(fresh);

  return peerResp;
}

module.exports = { cloneRepo, connectPeer, addRemote, authedUrl, buildConnectionString, wirePeerRemote, wireConnectedPeers };
