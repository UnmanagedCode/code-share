'use strict';
const fs = require('fs');
const path = require('path');
const { SERVE_DIR, PROJECTS_ROOT, loadRegistry, saveRegistry } = require('./config');

function isGitRepo(p) {
  try {
    return fs.statSync(path.join(p, '.git')).isDirectory();
  } catch {
    // Also allow bare repos
    try {
      return fs.statSync(path.join(p, 'HEAD')).isFile();
    } catch {
      return false;
    }
  }
}

function listShared() {
  return loadRegistry();
}

function addProject(absPath, name) {
  absPath = path.resolve(absPath);
  if (!fs.existsSync(absPath)) throw new Error(`Path does not exist: ${absPath}`);
  if (!isGitRepo(absPath)) throw new Error(`Not a git repository: ${absPath}`);

  const reg = loadRegistry();
  if (reg.find(p => p.name === name)) throw new Error(`Name already in use: ${name}`);
  if (reg.find(p => p.path === absPath)) throw new Error(`Repo already shared: ${absPath}`);

  const symlinkPath = path.join(SERVE_DIR, name + '.git');
  // Remove stale symlink if present
  try { fs.unlinkSync(symlinkPath); } catch {}
  fs.symlinkSync(absPath, symlinkPath);

  const entry = { name, path: absPath, role: null, peers: [] };
  reg.push(entry);
  saveRegistry(reg);
  return entry;
}

function removeProject(name) {
  const reg = loadRegistry();
  const idx = reg.findIndex(p => p.name === name);
  if (idx === -1) throw new Error(`Project not found: ${name}`);

  const symlinkPath = path.join(SERVE_DIR, name + '.git');
  try { fs.unlinkSync(symlinkPath); } catch {}

  reg.splice(idx, 1);
  saveRegistry(reg);
}

function findProject(name) {
  return loadRegistry().find(p => p.name === name) || null;
}

function updateProject(name, updates) {
  const reg = loadRegistry();
  const idx = reg.findIndex(p => p.name === name);
  if (idx === -1) throw new Error(`Project not found: ${name}`);
  Object.assign(reg[idx], updates);
  saveRegistry(reg);
  return reg[idx];
}

function addPeerToProject(projectName, peer) {
  const reg = loadRegistry();
  const proj = reg.find(p => p.name === projectName);
  if (!proj) return; // silently skip if project not found

  // Check for leader conflict
  if (peer.role === 'leader') {
    const existingLeader = proj.peers.find(p => p.role === 'leader');
    if (existingLeader) throw new Error(`Project "${projectName}" already has a leader: ${existingLeader.name}`);
  }

  const existing = proj.peers.findIndex(p => p.name === peer.name);
  if (existing >= 0) proj.peers[existing] = peer;
  else proj.peers.push(peer);

  saveRegistry(reg);
}

function scanProjectsRoot() {
  const reg = loadRegistry();
  const sharedPaths = new Set(reg.map(p => p.path));

  if (!fs.existsSync(PROJECTS_ROOT)) return [];

  const entries = [];
  try {
    for (const entry of fs.readdirSync(PROJECTS_ROOT)) {
      const fullPath = path.join(PROJECTS_ROOT, entry);
      try {
        if (fs.statSync(fullPath).isDirectory() && isGitRepo(fullPath)) {
          entries.push({ name: entry, path: fullPath, shared: sharedPaths.has(fullPath) });
        }
      } catch {}
    }
  } catch {}
  return entries;
}

module.exports = {
  listShared, addProject, removeProject, findProject,
  updateProject, addPeerToProject, scanProjectsRoot, isGitRepo
};
