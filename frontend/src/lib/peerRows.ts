import type { PeerCatalog, SharedEntry } from './types';

/** The last peer-status answer for one peer. */
export type PeerResult = { kind: 'pending' } | { kind: 'ok'; catalog: PeerCatalog } | { kind: 'error'; message: string };

export interface PeerRow {
  kind: 'sync' | 'clone';
  name: string;
}

export interface PeerRows {
  rows: PeerRow[];
  note?: 'checking' | 'empty' | 'offline';
  error?: string;
}

const norm = (s: unknown) => String(s ?? '').trim();

/**
 * The project rows under one connected peer.
 * - Live catalog: a Sync row for each project in both the catalog and the local registry (matched by trimmed
 *   name, shown with the local name), then a Clone row for each name only the peer has.
 * - No catalog yet, or the peer is offline: the projects the registry already has wired to this peer, as Sync rows.
 */
export function peerRows(peerName: string, registry: SharedEntry[], result: PeerResult): PeerRows {
  const wired: PeerRow[] = registry
    .filter((p) => (p.peers ?? []).some((pe) => pe.name === peerName))
    .map((p) => ({ kind: 'sync', name: p.name }));

  if (result.kind === 'pending') return wired.length ? { rows: wired } : { rows: [], note: 'checking' };
  if (result.kind === 'error') return wired.length ? { rows: wired } : { rows: [], note: 'offline', error: result.message };

  const localByName = new Map(registry.map((p) => [norm(p.name), p]));
  const sync: PeerRow[] = [];
  const clone: PeerRow[] = [];
  for (const ps of result.catalog.shared ?? []) {
    const local = localByName.get(norm(ps.name));
    if (local) sync.push({ kind: 'sync', name: local.name });
    else clone.push({ kind: 'clone', name: ps.name });
  }
  const rows = [...sync, ...clone];
  return rows.length ? { rows } : { rows, note: 'empty' };
}
