'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { DATA_DIR } = require('./config');

const CLOUDFLARED_BIN = path.join(DATA_DIR, 'cloudflared');
// ARM64 binary for Termux/Android; falls back gracefully on other arches
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function cloudflaredInPath() {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    function get(u) {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading cloudflared`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
      }).on('error', reject);
    }
    get(url);
  });
}

async function ensureCloudflared() {
  if (cloudflaredInPath()) return 'cloudflared';
  ensureDataDir();
  if (fs.existsSync(CLOUDFLARED_BIN)) return CLOUDFLARED_BIN;
  console.log('Downloading cloudflared ARM64 binary...');
  await downloadFile(CLOUDFLARED_URL, CLOUDFLARED_BIN);
  fs.chmodSync(CLOUDFLARED_BIN, 0o755);
  console.log('cloudflared downloaded to', CLOUDFLARED_BIN);
  return CLOUDFLARED_BIN;
}

async function startCloudflared(port) {
  const bin = await ensureCloudflared();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;
    const urlRegex = /https:\/\/[\w-]+\.trycloudflare\.com/;

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        resolve({ url: match[0], stop: () => proc.kill() });
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
    proc.on('exit', (code) => {
      if (!resolved) { resolved = true; reject(new Error(`cloudflared exited with code ${code}`)); }
    });

    setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error('cloudflared tunnel URL not detected within 30s')); }
    }, 30000);
  });
}

async function startLocaltunnel(port) {
  const localtunnel = require('localtunnel');
  const tunnel = await localtunnel({ port });
  tunnel.on('error', (e) => console.error('localtunnel error:', e.message));
  return { url: tunnel.url, stop: () => tunnel.close() };
}

async function startTunnel(type, port) {
  switch (type) {
    case 'cloudflared': return startCloudflared(port);
    case 'localtunnel': return startLocaltunnel(port);
    case 'none': return { url: null, stop: () => {} };
    default: throw new Error(`Unknown tunnel type: ${type}`);
  }
}

module.exports = { startTunnel };
