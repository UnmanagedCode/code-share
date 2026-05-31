#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const path = require('path');
const { loadConfig, saveConfig, loadRegistry, PROJECTS_ROOT } = require('../src/config');
const registry = require('../src/registry');
const { getLanIP, startMdns } = require('../src/lan');
const { startTunnel } = require('../src/tunnel');
const { startServer } = require('../src/server');
const { startWebUI } = require('../src/webui');
const { cloneRepo, connectPeer, authedUrl } = require('../src/peer');
const { sync } = require('../src/sync');

const program = new Command();

program
  .name('code-share')
  .description('Peer-to-peer read-only Git repo sharing over LAN or internet')
  .version('1.0.0');

// ─── serve ────────────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start read-only git server + tunnel + localhost web UI')
  .option('--port <n>', 'git server port', v => parseInt(v, 10))
  .option('--ui-port <n>', 'web UI port (localhost only)', v => parseInt(v, 10))
  .option('--tunnel <type>', 'tunnel type: cloudflared, localtunnel, none')
  .option('--mdns', 'advertise via mDNS')
  .option('--token <t>', 'override token')
  .action(async (opts) => {
    const cfg = loadConfig();
    if (opts.port) cfg.port = opts.port;
    if (opts.uiPort) cfg.uiPort = opts.uiPort;
    if (opts.tunnel) cfg.tunnel = opts.tunnel;
    if (opts.token) cfg.token = opts.token;
    if (opts.mdns !== undefined) cfg.mdns = opts.mdns;

    const { port, uiPort, tunnel, token } = cfg;

    const shared = loadRegistry();
    if (shared.length === 0) {
      console.log('Note: no repos are currently shared. Use `code-share share <path>` to add one.');
    } else {
      console.log(`Serving ${shared.length} repo(s): ${shared.map(p => p.name).join(', ')}`);
    }

    // Start git server
    await startServer(port, token);
    console.log(`Git server listening on 0.0.0.0:${port}`);

    // LAN info
    const lanIP = getLanIP();
    const lanBase = `http://x:${token}@${lanIP}:${port}`;
    cfg.selfUrl = lanBase;
    console.log(`LAN base URL: ${lanBase}`);
    if (shared.length > 0) {
      for (const p of shared) {
        console.log(`  /${p.name}.git`);
      }
    }

    // mDNS
    if (opts.mdns) startMdns(port, 'code-share');

    // Tunnel
    let tunnelStop = () => {};
    if (tunnel !== 'none') {
      console.log(`Starting ${tunnel} tunnel...`);
      try {
        const t = await startTunnel(tunnel, port);
        if (t.url) {
          const tunnelBase = `${t.url.replace(/\/$/, '')}`;
          cfg.tunnelUrl = `${tunnelBase}`.replace('://', `://x:${token}@`);
          tunnelStop = t.stop;
          console.log(`Tunnel URL: ${cfg.tunnelUrl}`);
        }
      } catch (e) {
        console.warn(`Tunnel failed (${tunnel}): ${e.message}. Continuing LAN-only.`);
      }
    }

    saveConfig(cfg);

    // Start web UI (localhost only — never tunneled)
    await startWebUI(uiPort);
    console.log(`Web UI: http://127.0.0.1:${uiPort}`);
    console.log('\nPress Ctrl+C to stop.');

    process.on('SIGINT', () => { tunnelStop(); process.exit(0); });
    process.on('SIGTERM', () => { tunnelStop(); process.exit(0); });
  });

// ─── share ────────────────────────────────────────────────────────────────────
program
  .command('share <repoPath>')
  .description('Add a repo to the shared scope')
  .option('--as <name>', 'name to serve the repo under (default: directory basename)')
  .action((repoPath, opts) => {
    const absPath = path.resolve(repoPath);
    const name = opts.as || path.basename(absPath);
    try {
      const entry = registry.addProject(absPath, name);
      console.log(`Shared: ${entry.name} → ${entry.path}`);
      const cfg = loadConfig();
      const base = cfg.tunnelUrl || cfg.selfUrl || `http://x:${cfg.token}@<host>:${cfg.port}`;
      console.log(`URL: ${base}/${entry.name}.git`);
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });

// ─── unshare ──────────────────────────────────────────────────────────────────
program
  .command('unshare <name>')
  .description('Remove a repo from the shared scope')
  .action((name) => {
    try {
      registry.removeProject(name);
      console.log(`Unshared: ${name}`);
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });

// ─── list ─────────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List shared repos with their URLs')
  .action(() => {
    const cfg = loadConfig();
    const shared = loadRegistry();
    if (shared.length === 0) {
      console.log('No repos currently shared. Use `code-share share <path>` to add one.');
      return;
    }
    const base = cfg.tunnelUrl || cfg.selfUrl || `http://x:${cfg.token}@<host>:${cfg.port}`;
    console.log('Shared repos:');
    for (const p of shared) {
      console.log(`  ${p.name}  →  ${p.path}`);
      console.log(`    URL: ${base}/${p.name}.git`);
      if (p.leader) console.log(`    Leader: yes`);
      if (p.peers && p.peers.length > 0) {
        for (const peer of p.peers) {
          console.log(`    Peer: ${peer.name} (${peer.url}) leader=${peer.leader ?? false}`);
        }
      }
    }
  });

// ─── clone ────────────────────────────────────────────────────────────────────
program
  .command('clone <url>')
  .description('Clone a peer project from zero')
  .option('--token <t>', 'auth token')
  .option('--dir <path>', 'destination directory')
  .action((url, opts) => {
    try {
      cloneRepo(url, opts.token, opts.dir);
    } catch (e) {
      console.error('Clone failed:', e.message);
      process.exit(1);
    }
  });

// ─── connect ──────────────────────────────────────────────────────────────────
program
  .command('connect <url>')
  .description('Wire peer in both directions via handshake. Accepts a cs1: connection string or a plain URL.')
  .option('--token <t>', 'peer auth token (not needed when using a cs1: connection string)')
  .option('--name <n>', 'local name for this peer', 'peer')
  .option('--leader', 'mark this side as leader for all shared projects (leader=true)')
  .option('--follower', 'mark this side as non-leader for all shared projects (leader=false)')
  .action(async (url, opts) => {
    let peerBaseUrl = url;
    let peerToken = opts.token || null;

    // Parse cs1: connection string (embeds url + token)
    if (url.startsWith('cs1:')) {
      try {
        const b64 = url.slice(4).replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
        const payload = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
        peerBaseUrl = payload.url;
        peerToken   = payload.token;
      } catch (e) {
        console.error('Connect failed: invalid cs1: connection string —', e.message);
        process.exit(1);
      }
    } else if (!peerToken) {
      // Try to extract token from embedded URL credentials
      try {
        const u = new URL(url);
        if (u.password) { peerToken = u.password; u.username = ''; u.password = ''; peerBaseUrl = u.toString(); }
      } catch {}
    }

    try {
      const result = await connectPeer(peerBaseUrl, peerToken, { name: opts.name });
      console.log(`Connected to peer "${opts.name}".`);
      if (result && result.shared && result.shared.length > 0) {
        console.log(`Peer shares: ${result.shared.join(', ')}`);
      }

      // Apply per-project leader flag if --leader or --follower was given
      if (opts.leader || opts.follower) {
        const leader = !!opts.leader;
        const shared = loadRegistry();
        for (const proj of shared) {
          registry.updateProject(proj.name, { leader });
        }
        console.log(`Leader set to ${leader} for all ${shared.length} shared project(s).`);
      }

      console.log('Both directions wired — each side can now sync independently.');
    } catch (e) {
      console.error('Connect failed:', e.message);
      process.exit(1);
    }
  });

// ─── sync ─────────────────────────────────────────────────────────────────────
program
  .command('sync [project]')
  .description('Pull-only sync from peer (never pushes)')
  .option('--remote <name>', 'peer remote name', 'peer')
  .option('--branch <b>', 'remote branch to fetch')
  .option('--rebase', 'use rebase instead of merge (advanced)')
  .action(async (project, opts) => {
    try {
      await sync(project, {
        remote: opts.remote,
        branch: opts.branch,
        useRebase: opts.rebase || false
      });
    } catch (e) {
      console.error('Sync failed:', e.message);
      process.exit(1);
    }
  });

// ─── status ───────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show instance status: token, URLs, shared repos, peers')
  .action(() => {
    const cfg = loadConfig();
    const shared = loadRegistry();

    console.log('=== code-share status ===');
    console.log(`Token:      ${cfg.token}`);
    console.log(`Port:       ${cfg.port}`);
    console.log(`UI port:    ${cfg.uiPort}`);
    console.log(`Tunnel:     ${cfg.tunnel}`);
    console.log(`LAN URL:    ${cfg.selfUrl || '(not serving)'}`);
    console.log(`Tunnel URL: ${cfg.tunnelUrl || '(none)'}`);
    console.log(`Projects root: ${PROJECTS_ROOT}`);
    console.log(`\nShared repos (${shared.length}):`);
    if (shared.length === 0) {
      console.log('  (none — use `share <path>` to add)');
    } else {
      for (const p of shared) {
        console.log(`  ${p.name}  [${p.leader ? 'leader' : 'sync'}]`);
        console.log(`    Path: ${p.path}`);
        if (p.peers && p.peers.length > 0) {
          for (const peer of p.peers) {
            console.log(`    Peer: ${peer.name}  leader=${peer.leader ?? false}  ${peer.url}`);
          }
        }
      }
    }

    const peers = cfg.peers || [];
    console.log(`\nInstance peers (${peers.length}):`);
    if (peers.length === 0) {
      console.log('  (none — use `connect <url>` to add)');
    } else {
      for (const p of peers) {
        console.log(`  ${p.name}  ${p.url}`);
      }
    }
  });

program.parse(process.argv);
