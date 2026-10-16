import { describe, expect, it } from 'vitest';
import { peerRows } from './peerRows';
import type { SharedEntry } from './types';

const entry = (name: string, peers: string[] = []): SharedEntry => ({ name, path: `/p/${name}`, peers: peers.map((n) => ({ name: n })) });
const registry = [entry('alpha', ['peer']), entry('beta', ['other']), entry(' gamma ', [])];
const sync = (name: string) => ({ kind: 'sync', name });
const clone = (name: string) => ({ kind: 'clone', name });

describe('peerRows', () => {
  // Invariant: before the live catalog arrives, the projects wired to THIS peer show as Sync rows; with none, "checking".
  it('pending: the wired fallback, or checking', () => {
    expect(peerRows('peer', registry, { kind: 'pending' })).toEqual({ rows: [sync('alpha')] });
    expect(peerRows('nobody', registry, { kind: 'pending' })).toEqual({ rows: [], note: 'checking' });
  });

  // Invariant: a live catalog is the source of truth: Sync rows for catalog ∩ registry (matched by trimmed name,
  // shown with the local name, whatever the wiring), then Clone rows for names only the peer has.
  it('ok: sync rows for shared names, then clone rows', () => {
    const r = peerRows('peer', registry, { kind: 'ok', catalog: { shared: [{ name: 'delta' }, { name: 'gamma' }, { name: 'beta ' }] } });
    expect(r).toEqual({ rows: [sync(' gamma '), sync('beta'), clone('delta')] });
  });

  // Invariant: a reachable peer sharing nothing says so, even when the registry has wired rows.
  it('ok: an empty catalog is "empty"', () => {
    expect(peerRows('peer', registry, { kind: 'ok', catalog: { shared: [] } })).toEqual({ rows: [], note: 'empty' });
    expect(peerRows('peer', registry, { kind: 'ok', catalog: {} })).toEqual({ rows: [], note: 'empty' });
  });

  // Invariant: an unreachable peer keeps its wired rows; with none, it reads offline with the error.
  it('error: wired rows kept, otherwise offline', () => {
    expect(peerRows('peer', registry, { kind: 'error', message: 'down' })).toEqual({ rows: [sync('alpha')] });
    expect(peerRows('nobody', registry, { kind: 'error', message: 'Could not reach peer: x' })).toEqual({
      rows: [],
      note: 'offline',
      error: 'Could not reach peer: x',
    });
  });
});
