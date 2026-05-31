'use strict';
const { spawn, execSync } = require('child_process');

function ensureCloudflared() {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      'cloudflared not found in PATH.\n' +
      'Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
      'Then re-run this command.'
    );
  }
  return 'cloudflared';
}

async function startCloudflared(port) {
  const bin = ensureCloudflared();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;
    const urlRegex = /https:\/\/(?!api\.)[\w-]+\.trycloudflare\.com/;

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
