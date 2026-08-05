'use strict';
const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');
const { loadConfig, saveConfig, loadRegistry, saveRegistry } = require('./config');
const registry = require('./registry');
const { isServing, isInternetUrl } = require('./serve-state');

function authedUrl(base, token) {
  const u = new URL(base);
  u.username = 'x';
  u.password = token;
  return u.toString();
}

// Build a cs1: connection string from a base URL + token (mirrors the web UI's
// makeConnectionString in static/ui.html). Strips any embedded credentials and
// base64url-encodes a {url, token} payload. Returns null if url is missing/invalid.
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

// Run a git command with piped stdio so its stderr is captured and surfaced.
// Mirrors src/sync.js's run(): the child's stdout/stderr are fresh pipes, never
// the server's (possibly orphaned) stdio, so a dead parent's closed sockets
// can't SIGPIPE the child. Uses argv form (not `sh -c`) so credential-bearing
// URLs and arbitrary paths need no shell quoting.
function runGit(args, opts = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  if (result.error) throw new Error(`Failed to run git: ${result.error.message}`);
  return { stdout: result.stdout || '', stderr: result.stderr || '', code: result.status };
}

function cloneRepo(url, token, dir) {
  const cloneUrl = token ? authedUrl(url, token) : url;
  const target = dir || '.';
  const r = runGit(['clone', cloneUrl, target]);
  if (r.code !== 0) {
    throw new Error((r.stderr || '').trim() || `git clone failed with status ${r.code}`);
  }
}

function addRemote(repoPath, name, url) {
  const add = runGit(['-C', repoPath, 'remote', 'add', name, url]);
  if (add.code === 0) return;
  // Fall back to set-url only when the remote actually exists; surface every
  // other git failure with its real stderr instead of swallowing it.
  if (/already exists/i.test(add.stderr)) {
    const set = runGit(['-C', repoPath, 'remote', 'set-url', name, url]);
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
function wirePeerRemote(projectName, repoPath, pr) {
  const projUrl = pr.url.replace(/\/?$/, '') + '/' + projectName + '.git';
  addRemote(repoPath, pr.name, authedUrl(projUrl, pr.token));
  registry.addPeerToProject(projectName, { name: pr.name, url: pr.url, token: pr.token, leader: false });
  return { name: pr.name, url: projUrl };
}

// Wire every currently-connected peer onto a project. Shared by the CLI `share`
// command and the web UI's /api/share and /api/clone so the peer association is
// populated consistently no matter which path shares a project.
// Returns the list of wired peers ([{ name, url }]) for caller-side logging.
function wireConnectedPeers(projectName, repoPath) {
  const cfg = loadConfig();
  return (cfg.peers || []).map(pr => wirePeerRemote(projectName, repoPath, pr));
}

function getJSON(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Authorization': `Basic ${Buffer.from(`x:${token}`).toString('base64')}`
      }
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${text.trim()}`)); return; }
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function postJSON(url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Basic ${Buffer.from(`x:${token}`).toString('base64')}`
      }
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.trim()}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function connectPeer(peerBaseUrl, peerToken, opts = {}) {
  const { name = 'peer' } = opts;
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
    peerResp = await postJSON(registerUrl, {
      url: selfUrl,
      token: selfToken,
      name,
      projectLeaders
    }, peerToken);
  } catch (e) {
    throw new Error(`Failed to reach peer at ${registerUrl}: ${e.message}`);
  }

  // Save peer in our instance config. Re-read fresh rather than reusing the
  // `cfg` snapshot from before the network round-trip above — another request
  // (e.g. a runtime tunnel start/stop) may have written config.json meanwhile,
  // and saving the stale snapshot here would silently revert that write.
  const fresh = loadConfig();
  const peers = fresh.peers || [];
  const existingIdx = peers.findIndex(p => p.name === name);
  const peerEntry = { name, url: peerBaseUrl, token: peerToken };
  if (existingIdx >= 0) peers[existingIdx] = peerEntry;
  else peers.push(peerEntry);
  fresh.peers = peers;
  saveConfig(fresh);

  // Fetch peer's current project leader flags so we can store them
  let peerLeaders = {};
  try {
    const statusUrl = peerBaseUrl.replace(/\/?$/, '') + '/control/status';
    const peerStatus = await getJSON(statusUrl, peerToken);
    for (const s of (peerStatus.shared || [])) {
      peerLeaders[s.name] = s.leader ?? false;
    }
  } catch {
    // peer status unreachable; peerEntry.leader defaults to false
  }

  // Add peer to all shared projects in registry
  for (const proj of reg) {
    const authedPeerUrl = authedUrl(peerBaseUrl + '/' + proj.name + '.git', peerToken);
    addRemote(proj.path, name, authedPeerUrl);

    const pe = { name, url: peerBaseUrl, token: peerToken, leader: peerLeaders[proj.name] ?? false };
    const existingPeer = proj.peers.findIndex(p => p.name === name);
    if (existingPeer >= 0) proj.peers[existingPeer] = pe;
    else proj.peers.push(pe);
  }
  saveRegistry(reg);

  return peerResp;
}

module.exports = { cloneRepo, connectPeer, addRemote, authedUrl, buildConnectionString, wirePeerRemote, wireConnectedPeers };
