'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SERVE_DIR = path.join(DATA_DIR, 'serve');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');

// Default: parent of the code-share project directory
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.resolve(PROJECT_ROOT, '..');

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SERVE_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDirs();
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaults = {
      token: generateToken(),
      port: 9419,
      uiPort: 9420,
      tunnel: 'cloudflared',
      mdns: false,
      selfUrl: null,
      tunnelUrl: null,
      peers: []
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(obj) {
  ensureDataDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2));
}

function loadRegistry() {
  ensureDataDirs();
  if (!fs.existsSync(REGISTRY_FILE)) {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify([], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
}

function saveRegistry(arr) {
  ensureDataDirs();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(arr, null, 2));
}

module.exports = {
  PROJECT_ROOT, DATA_DIR, SERVE_DIR, PROJECTS_ROOT,
  generateToken, ensureDataDirs,
  loadConfig, saveConfig,
  loadRegistry, saveRegistry
};
