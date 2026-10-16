'use strict';
const path = require('path');
const { loadConfig, loadRegistry, PROJECTS_ROOT } = require('./config');
const registry = require('./registry');
const peer = require('./peer');
const { sync, getSyncState } = require('./sync');
const tunnelManager = require('./tunnel-manager');

// Bare tool names as declared in conductor.plugin.json — the conductor namespaces
// these as <plugin-id>__<tool> before exposing them to MCP callers.
const TOOLS = {
  status() {
    const cfg = loadConfig();
    const reg = loadRegistry();
    const ts = tunnelManager.getTunnelStatus();
    return {
      selfUrl: cfg.selfUrl,
      tunnelUrl: cfg.tunnelUrl,
      port: cfg.port,
      uiPort: cfg.uiPort,
      tunnel: cfg.tunnel,
      tunnelStarting: ts.starting,
      projectsRoot: PROJECTS_ROOT,
      shared: reg,
      peers: cfg.peers || []
    };
  },

  async share({ repoPath, name, leader } = {}) {
    if (!repoPath) throw new Error('repoPath is required');
    const absPath = path.resolve(repoPath);
    const entryName = name || path.basename(absPath);
    const entry = registry.addProject(absPath, entryName, !!leader);
    await peer.wireConnectedPeers(entryName, entry.path);
    return entry;
  },

  async sync({ project, remote = 'peer', branch, useRebase = false } = {}) {
    const outcome = await sync(project, { remote, branch, useRebase: !!useRebase });
    return await getSyncState(outcome.project, { remote });
  }
};

// Wire contract (per code-conductor's plugin protocol): request body is
// {tool, arguments, caller}; response MUST be HTTP 200 for every well-formed
// invocation, body {result} on success or {error: "message"} on tool-level
// failure — a non-200 response is treated as a transport-level failure.
async function handleMCP(req, res, readBody, sendJSON) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJSON(res, 200, { error: 'Invalid JSON body' });
    return;
  }

  const { tool, arguments: args } = body || {};
  const fn = TOOLS[tool];
  if (!fn) {
    sendJSON(res, 200, { error: `Unknown tool: ${tool}` });
    return;
  }

  try {
    const result = await fn(args || {});
    sendJSON(res, 200, { result: result === undefined ? null : result });
  } catch (e) {
    sendJSON(res, 200, { error: e.message });
  }
}

module.exports = { handleMCP };
