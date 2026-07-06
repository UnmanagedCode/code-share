'use strict';
const { startTunnel } = require('./tunnel');
const { loadConfig, saveConfig } = require('./config');

let port = null, token = null;
let currentType = null;
let currentStop = () => {};
let currentUrl = null;        // credentialed URL, mirrors cfg.tunnelUrl
let starting = false;
let cancelRequested = false;

function toAuthedUrl(rawUrl, tok) {
  return rawUrl.replace(/\/$/, '').replace('://', `://x:${tok}@`);
}

function init(p, t) { port = p; token = t; }

// Pure in-memory setter — called by the STARTUP path in bin/code-share.js right
// after it computes cfg.tunnelUrl itself and does its own single saveConfig(cfg)
// (which already covers selfUrl, tunnelUrl, etc). No disk I/O here, so it can't
// race or double-write against that startup save.
function setActive(type, stop, url) {
  currentType = type; currentStop = stop || (() => {}); currentUrl = url || null;
}

function getTunnelStatus() {
  return { active: !!currentUrl, type: currentType, url: currentUrl, starting };
}

// Full flow used ONLY by the running-server API/button path (serve already up).
async function startRuntimeTunnel(type = 'cloudflared') {
  const ALLOWED = ['cloudflared', 'localtunnel'];
  if (!ALLOWED.includes(type)) throw new Error(`type must be one of: ${ALLOWED.join(', ')}`);
  if (starting) throw new Error('Tunnel is already starting');
  if (currentUrl) throw new Error('A tunnel is already running — stop it first');
  if (port == null || token == null) throw new Error('Tunnel manager not initialized — is serve running?');
  starting = true;
  try {
    const t = await startTunnel(type, port);          // up to 30s for cloudflared; may reject
    if (cancelRequested) {                             // Stop was clicked while this was in flight
      try { t.stop(); } catch {}
      throw new Error('Tunnel start cancelled');
    }
    if (!t.url) throw new Error(`Tunnel type "${type}" did not produce a public URL`);
    const url = toAuthedUrl(t.url, token);
    setActive(type, t.stop, url);
    const cfg = loadConfig();   // re-read fresh: other endpoints may have written meanwhile
    cfg.tunnelUrl = url;
    saveConfig(cfg);
  } finally {
    starting = false;
    cancelRequested = false;
  }
  return getTunnelStatus();   // computed after `finally` so `starting` is already false
}

// Shared by the stop API endpoint AND process SIGINT/SIGTERM in bin/code-share.js.
function stopRuntimeTunnel() {
  if (starting) { cancelRequested = true; return getTunnelStatus(); }
  try { currentStop(); } catch {}
  currentStop = () => {}; currentType = null; currentUrl = null;
  const cfg = loadConfig();
  cfg.tunnelUrl = null;
  saveConfig(cfg);
  return getTunnelStatus();
}

module.exports = { init, setActive, getTunnelStatus, startRuntimeTunnel, stopRuntimeTunnel, toAuthedUrl };
