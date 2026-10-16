// Gives a test file its own config and registry (in memory) and its own served-links
// directory, instead of the checkout's data/. Import it before anything requires
// another backend module: they all destructure ./config when they load.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { require } from './_backend.mjs';

const config = require('../src/config');
export const DATA = mkdtempSync(path.join(os.tmpdir(), 'code-share-data-'));
export const SERVE_DIR = path.join(DATA, 'serve');
mkdirSync(SERVE_DIR);

const clone = (v) => JSON.parse(JSON.stringify(v));
export const store = {
  config: { token: 'tok', port: 0, uiPort: 0, tunnel: 'none', mdns: false, selfUrl: null, tunnelUrl: null, peers: [] },
  registry: [],
};
Object.assign(config, {
  DATA_DIR: DATA,
  SERVE_DIR,
  loadConfig: () => clone(store.config),
  saveConfig: (c) => { store.config = clone(c); },
  loadRegistry: () => clone(store.registry),
  saveRegistry: (r) => { store.registry = clone(r); },
});
