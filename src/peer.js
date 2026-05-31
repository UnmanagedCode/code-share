'use strict';
const { execSync, exec } = require('child_process');
const http = require('http');
const https = require('https');
const { loadConfig, saveConfig, loadRegistry, saveRegistry } = require('./config');
const registry = require('./registry');

function authedUrl(base, token) {
  const u = new URL(base);
  u.username = 'x';
  u.password = token;
  return u.toString();
}

function cloneRepo(url, token, dir) {
  const cloneUrl = token ? authedUrl(url, token) : url;
  const target = dir || '.';
  execSync(`git clone "${cloneUrl}" "${target}"`, { stdio: 'inherit' });
}

function addRemote(repoPath, name, url) {
  try {
    execSync(`git -C "${repoPath}" remote add "${name}" "${url}"`, { stdio: 'ignore' });
  } catch {
    // Remote already exists — update URL
    execSync(`git -C "${repoPath}" remote set-url "${name}" "${url}"`, { stdio: 'ignore' });
  }
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
  const selfToken = cfg.token;
  const selfUrl = cfg.selfUrl || cfg.tunnelUrl;

  if (!selfUrl) {
    throw new Error('No selfUrl set — run `serve` first so your URL is known before connecting');
  }

  // Build per-project roles map from our current registry
  const reg = loadRegistry();
  const projectRoles = {};
  for (const proj of reg) {
    projectRoles[proj.name] = proj.role;
  }

  // POST our info to peer's control endpoint
  const registerUrl = peerBaseUrl.replace(/\/?$/, '') + '/control/register';
  let peerResp;
  try {
    peerResp = await postJSON(registerUrl, {
      url: selfUrl,
      token: selfToken,
      name,
      projectRoles
    }, peerToken);
  } catch (e) {
    throw new Error(`Failed to reach peer at ${registerUrl}: ${e.message}`);
  }

  // Save peer in our instance config (role removed — now per-project in registry)
  const peers = cfg.peers || [];
  const existingIdx = peers.findIndex(p => p.name === name);
  const peerEntry = { name, url: peerBaseUrl, token: peerToken };
  if (existingIdx >= 0) peers[existingIdx] = peerEntry;
  else peers.push(peerEntry);
  cfg.peers = peers;
  saveConfig(cfg);

  // Add peer to all shared projects in registry
  for (const proj of reg) {
    const authedPeerUrl = authedUrl(peerBaseUrl + '/' + proj.name + '.git', peerToken);
    addRemote(proj.path, name, authedPeerUrl);

    const pe = { name, url: peerBaseUrl, token: peerToken, role: null };
    const existingPeer = proj.peers.findIndex(p => p.name === name);
    if (existingPeer >= 0) proj.peers[existingPeer] = pe;
    else proj.peers.push(pe);
    // Per-project role (proj.role) is managed separately via /api/project-role
  }
  saveRegistry(reg);

  return peerResp;
}

module.exports = { cloneRepo, connectPeer, addRemote, authedUrl };
