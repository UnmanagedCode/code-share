'use strict';
const path = require('path');
const { loadConfig, loadRegistry, PROJECTS_ROOT } = require('./config');
const registry = require('./registry');
const peer = require('./peer');
const syncMod = require('./sync');
const tunnelManager = require('./tunnel-manager');
const { CodedError } = require('./coded-error');
const { checkPeerName, checkBranch } = require('./names');

const str = (v) => (typeof v === 'string' ? v : null);
const portOf = (v) => (typeof v === 'number' || typeof v === 'string' ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : {});
// `role` is the pre-`leader` flag; stored records may still carry only that.
const leaderOf = (x) => (typeof x.leader === 'boolean' ? x.leader : x.role === 'leader');
const list = (v) => (Array.isArray(v) ? v : []);

const badRequest = (message, argument) => new CodedError('BAD_REQUEST', message, { argument });

// Re-throws a names.js refusal with the argument it was raised for.
function checkArg(argument, fn, value) {
  try {
    fn(value);
  } catch (e) {
    if (e instanceof CodedError) e.details = { argument };
    throw e;
  }
}

// Bare tool names as declared in conductor.plugin.json — the conductor namespaces
// these as <plugin-id>__<tool> before exposing them to MCP callers. Each returns the
// data object that is the json view and the input to the text view.
const TOOLS = {
  status() {
    const cfg = loadConfig();
    const reg = loadRegistry();
    const ts = tunnelManager.getTunnelStatus();
    return {
      selfUrl: str(cfg.selfUrl),
      tunnelUrl: str(cfg.tunnelUrl),
      port: portOf(cfg.port),
      uiPort: portOf(cfg.uiPort),
      tunnel: str(cfg.tunnel),
      tunnelStarting: !!ts.starting,
      projectsRoot: PROJECTS_ROOT,
      shared: list(reg).map(obj).map(e => ({
        name: str(e.name),
        path: str(e.path),
        leader: leaderOf(e),
        peers: list(e.peers).map(obj).map(p => ({ name: str(p.name), url: str(p.url), token: str(p.token), leader: leaderOf(p) })),
      })),
      peers: list(cfg.peers).map(obj).map(p => ({ name: str(p.name), url: str(p.url), token: str(p.token) })),
    };
  },

  async share(args) {
    const { repoPath, name, leader } = args;
    if (typeof repoPath !== 'string' || repoPath === '') throw badRequest('repoPath is required', 'repoPath');
    if (name !== undefined && typeof name !== 'string') throw badRequest('name must be a string', 'name');
    if (leader !== undefined && typeof leader !== 'boolean') throw badRequest('leader must be a boolean', 'leader');
    const absPath = path.resolve(repoPath);
    const entryName = name || path.basename(absPath);
    let entry;
    try {
      entry = registry.addProject(absPath, entryName, !!leader);
    } catch (e) {
      if (e instanceof CodedError && e.code === 'INVALID_NAME') e.details = { argument: 'name' };
      throw e;
    }
    const skippedPeers = [];
    let wired;
    try {
      wired = await peer.wireConnectedPeers(entryName, entry.path, skippedPeers);
    } catch (e) {
      throw new CodedError(
        'PEER_WIRING_FAILED',
        `Shared ${entryName}, but wiring the git remote for peer ${JSON.stringify(e.peer)} failed: ${e.message}`,
        { name: entryName, path: entry.path, peer: str(e.peer), shared: true },
      );
    }
    return { name: entry.name, path: entry.path, leader: !!entry.leader, wiredPeers: wired.map(w => w.name), skippedPeers };
  },

  async sync(args) {
    const { project, remote = 'peer', branch, useRebase = false } = args;
    for (const k of ['project', 'remote', 'branch']) {
      if (args[k] !== undefined && typeof args[k] !== 'string') throw badRequest(`${k} must be a string`, k);
    }
    if (typeof useRebase !== 'boolean') throw badRequest('useRebase must be a boolean', 'useRebase');
    checkArg('remote', checkPeerName, remote);
    if (branch) checkArg('branch', checkBranch, branch);
    const outcome = await syncMod.sync(project, { remote, branch, useRebase });
    let state;
    try {
      state = await syncMod.getSyncState(outcome.project, { remote });
    } catch (e) {
      if (e instanceof CodedError && e.code === 'FETCH_FAILED') {
        throw new CodedError(
          'SYNC_STATE_UNAVAILABLE',
          `Synced ${outcome.project} (${outcome.mode}), but reading the ahead/behind state failed: ${e.message}`,
          { project: outcome.project, remote, mode: outcome.mode, synced: true },
        );
      }
      throw e;
    }
    return { project: outcome.project, remote, mode: outcome.mode, ahead: state.ahead, behind: state.behind, state: state.state };
  },
};

const TOOL_NAMES = Object.keys(TOOLS);

const MODE_LABELS = {
  rebase: 'rebase (useRebase)',
  'fast-forward': "follower fast-forward to the leader's tip",
  'follower-rebase': "follower rebase onto the leader's tip",
  'symmetric-merge': 'symmetric merge (merge --no-ff)',
  'leader-ingest': 'leader ingesting follower (merge --no-ff)',
};

// Text views only: C0/C1 controls and the Unicode line separators are shown as visible escapes, so a
// peer-sourced string can never start a line of its own. Nothing is dropped; the json view stays raw.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const esc = (v) => String(v).replace(CONTROLS, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const orNone = (v) => (v === null ? '(none)' : esc(v));

function stateSentence({ state, ahead, behind }) {
  switch (state) {
    case 'in-sync': return 'Now in sync (0 ahead, 0 behind).';
    case 'local-ahead': return `Now ${ahead} ahead, 0 behind: the peer has not synced your commits yet.`;
    case 'remote-ahead': return `Now 0 ahead, ${behind} behind.`;
    default: return `Now ${ahead} ahead and ${behind} behind (diverged).`;
  }
}

// Prose views of the data objects above. Every list is printed in full.
const TEXT_VIEWS = {
  status(d) {
    const tunnel = d.tunnelUrl !== null ? `running at ${esc(d.tunnelUrl)}` : d.tunnelStarting ? 'starting' : 'not running';
    const lines = [
      'code-share status',
      `Git server port ${d.port === null ? '(unset)' : esc(d.port)}, web UI port ${d.uiPort === null ? '(unset)' : esc(d.uiPort)} (persisted). Tunnel (default ${d.tunnel === null ? '(unset)' : esc(d.tunnel)}): ${tunnel}.`,
      `LAN URL: ${d.selfUrl === null ? '(not serving yet)' : esc(d.selfUrl)}`,
      `Projects root: ${esc(d.projectsRoot)}`,
      '',
    ];
    if (d.shared.length === 0) {
      lines.push('No projects are shared; use the share tool to add one.');
    } else {
      lines.push(`Shared projects (${d.shared.length}):`);
      for (const p of d.shared) {
        lines.push(`- ${orNone(p.name)} — ${p.leader ? 'leader' : 'follower'} — ${orNone(p.path)}${p.peers.length === 0 ? ' (no peers wired)' : ''}`);
        for (const q of p.peers) {
          lines.push(`  peer ${orNone(q.name)}: ${q.leader ? 'leader' : 'follower'}, url ${orNone(q.url)}, token ${orNone(q.token)}`);
        }
      }
    }
    lines.push('');
    if (d.peers.length === 0) {
      lines.push('No peers are connected.');
    } else {
      lines.push(`Connected peers (${d.peers.length}):`);
      for (const q of d.peers) lines.push(`- ${orNone(q.name)} — url ${orNone(q.url)} — token ${orNone(q.token)}`);
    }
    return lines.join('\n');
  },

  share(d) {
    const lines = [`Shared ${esc(d.name)} (${d.leader ? 'leader' : 'follower'}) from ${esc(d.path)}.`];
    lines.push(d.wiredPeers.length > 0
      ? `Wired the git remote for peers: ${d.wiredPeers.map(esc).join(', ')}.`
      : 'No peers are connected, so no peer remotes were wired.');
    if (d.skippedPeers.length > 0) {
      lines.push(`Skipped unusable peer entries: ${d.skippedPeers.map(n => (n === null ? '(unnamed)' : esc(n))).join(', ')}; reconnect them under a valid name.`);
    }
    return lines.join('\n');
  },

  sync(d) {
    return `Synced ${esc(d.project)} from remote "${esc(d.remote)}" by ${MODE_LABELS[d.mode]}. ${stateSentence(d)}`;
  },
};

// A bounded, never-throwing rendering of a caller-supplied value for an error message.
function echo(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch { /* BigInt, circular, too deep */ }
  if (typeof s !== 'string') s = typeof v;
  return s.length > 64 ? s.slice(0, 64) + '…' : s;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Answers one MCP request body ({tool, arguments, caller, format}); never throws. */
async function handle(body) {
  const format = body?.format === undefined ? 'text' : body.format;
  if (format !== 'text' && format !== 'json') {
    return { error: `format must be "text" or "json", got ${echo(format)}`, code: 'FORMAT_UNKNOWN' };
  }
  const tool = body?.tool;
  if (typeof tool !== 'string' || !Object.hasOwn(TOOLS, tool)) {
    return { error: `Unknown tool: ${echo(tool)}`, code: 'TOOL_UNKNOWN' };
  }
  const args = body.arguments ?? {};
  if (!isPlainObject(args)) return { error: 'arguments must be an object', code: 'BAD_REQUEST' };

  try {
    const data = await TOOLS[tool](args);
    return format === 'json' ? { structured: data } : { text: TEXT_VIEWS[tool](data) };
  } catch (err) {
    if (err instanceof CodedError) {
      return { error: err.brief ?? err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
    }
    try { console.error(err && err.stack); } catch { /* stderr gone */ }
    return { error: `${tool} failed unexpectedly: ${err && err.message}`, code: 'INTERNAL' };
  }
}

// Wire contract (per code-conductor's plugin protocol): request body is
// {tool, arguments, caller, format}; response MUST be HTTP 200 for every well-formed
// invocation, body {structured} (format "json", validated by the conductor against the
// manifest outputSchema), {text} (format "text" or absent), or {error, code, details?}
// on a refusal — a non-200 response is treated as a transport-level failure.
async function handleMCP(req, res, readBody, sendJSON) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 200, { error: 'Invalid JSON body', code: 'BAD_REQUEST' });
  }
  sendJSON(res, 200, await handle(body));
}

module.exports = { handleMCP, handle, TOOL_NAMES };
