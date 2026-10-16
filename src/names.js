'use strict';
// Guards for strings that arrive from a peer (or any caller of the APIs) and
// end up in a filesystem path or a git argument. Each throws a plain Error
// whose message is safe to return to the caller.
const path = require('path');

// C0 controls (NUL included) and DEL.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A project name a peer supplied (its catalog): one plain path segment. Refuses
 * empty, `.`/`..`, a leading `.` or `-`, `/`, `\` and control characters.
 */
function checkProjectName(name) {
  if (typeof name !== 'string' || name === '') throw new Error('Invalid project name: empty');
  if (CONTROL.test(name)) throw new Error('Invalid project name: control character');
  if (name.includes('/') || name.includes('\\')) throw new Error(`Invalid project name: ${JSON.stringify(name)} contains a path separator`);
  if (name.startsWith('.')) throw new Error(`Invalid project name: ${JSON.stringify(name)} starts with "."`);
  if (name.startsWith('-')) throw new Error(`Invalid project name: ${JSON.stringify(name)} starts with "-"`);
  return name;
}

// A git remote name code-share writes: letters, digits, `.`, `_`, `-`, starting with a letter or digit.
const PEER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A peer name: it becomes a git remote name and a git argument, so a strict charset with no leading `-`. */
function checkPeerName(name) {
  if (typeof name !== 'string' || !PEER_NAME_RE.test(name) || name.includes('..') || /\.(lock)?$/.test(name)) {
    throw new Error(`Invalid peer name: ${JSON.stringify(name)} (use letters, digits, ".", "_" or "-", starting with a letter or digit)`);
  }
  return name;
}

/** A peer base URL: http or https only, so git never sees a file:, ext:: or other transport from a peer. */
function checkPeerUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid peer URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Invalid peer URL: ${url} (http or https only)`);
  return url;
}

/**
 * A name for the registry and the served `<name>.git` link, from any caller (CLI, web UI, MCP, clone). Only
 * containment is required here: a local repo may well be called `.dotfiles`.
 */
function checkShareName(name) {
  if (typeof name !== 'string' || name === '') throw new Error('Invalid project name: empty');
  if (CONTROL.test(name)) throw new Error('Invalid project name: control character');
  if (name.includes('/') || name.includes('\\')) throw new Error(`Invalid project name: ${JSON.stringify(name)} contains a path separator`);
  return name;
}

/** `root/name`, resolved, when it is strictly inside `root` (a child, never `root` itself); throws otherwise. */
function childPath(root, name) {
  const base = path.resolve(root);
  const dest = path.resolve(base, name);
  if (path.dirname(dest) !== base) throw new Error(`Refusing a path outside ${base}: ${dest}`);
  return dest;
}

module.exports = { checkProjectName, checkShareName, checkPeerName, checkPeerUrl, childPath, PEER_NAME_RE };
