'use strict';
// A clone is made in a staging directory beside its target and renamed into
// place only once it is complete, so a failed, killed or concurrent clone
// never leaves (or removes) anything under the target's name. Staging
// directories are hidden from the project scanner and swept at startup.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { killAllGit } = require('./git');

const STAGING_PREFIX = '.code-share-clone-';
// `<prefix><pid>-<random hex>`: the pid of the process whose clone it is.
const STAGING_RE = /^\.code-share-clone-(\d+)-[0-9a-f]+$/;

// Staging directories of clones still running in this process.
const active = new Set();

/** A fresh, unused staging path beside `target`; tracked until released. */
function stagingPathFor(target) {
  const dir = path.join(path.dirname(target), `${STAGING_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  active.add(dir);
  return dir;
}

/** Removes a staging directory (if it is there) and stops tracking it. */
function releaseStaging(dir) {
  active.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    console.error(`Could not remove clone staging directory ${dir}: ${e.message}`);
  }
}

/** Removes every staging directory of this process's running clones (on shutdown, after their git is killed). */
function releaseAllStaging() {
  for (const dir of [...active]) releaseStaging(dir);
}

// On any exit: git first (it would keep writing), then the staging directories it was writing.
process.on('exit', () => {
  killAllGit();
  releaseAllStaging();
});

/** Whether a directory entry name is a staging directory (never a project). */
const isStagingName = (name) => name.startsWith(STAGING_PREFIX);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, owned by someone else
  }
}

/**
 * Removes staging directories directly inside `root` left by a process that is no longer running. Only names
 * matching STAGING_RE are touched; a running process's clone (another code-share on the same root) is kept.
 * Returns the paths removed.
 */
function sweepStaleStaging(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const m = STAGING_RE.exec(name);
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    const dir = path.join(root, name);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      removed.push(dir);
    } catch (e) {
      console.error(`Could not remove stale clone staging directory ${dir}: ${e.message}`);
    }
  }
  return removed;
}

module.exports = { STAGING_PREFIX, STAGING_RE, stagingPathFor, releaseStaging, releaseAllStaging, isStagingName, sweepStaleStaging };
