import { useEffect, useRef, useState } from 'react';
import { ArrowUpDownIcon, DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/ActionButton';
import { ErrorDetails } from '@/components/ErrorDetails';
import { Section } from '@/components/Section';
import { SectionState } from '@/components/SectionState';
import { api } from '@/lib/api';
import { peerRows, type PeerResult } from '@/lib/peerRows';
import { syncBadge } from '@/lib/syncBadge';
import type { PeerCatalog, PeerRef, SharedEntry, Status, SyncState } from '@/lib/types';
import { errorMessage, type Polled } from '@/lib/usePoll';

/** What a Sync or Clone row last showed, kept per (peer, project) across refreshes. */
interface RowState {
  fetching?: boolean;
  syncing?: boolean;
  cloning?: boolean;
  result?: { kind: 'state'; state: SyncState } | { kind: 'error'; label: string; message: string };
}

const rowKey = (peer: string, project: string) => `${peer}\n${project}`;
const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** "Connected Peers": per peer, the projects to Sync (both sides share them) or Clone (only the peer has them). */
export function PeersCard({ status, refreshAll }: { status: Polled<Status>; refreshAll: () => Promise<void> }) {
  const [results, setResults] = useState<Record<string, PeerResult>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const inFlight = useRef(new Set<string>());

  // Every status load re-checks each peer's live catalog; the last answer stays shown meanwhile.
  useEffect(() => {
    for (const p of status.data?.peers ?? []) {
      if (inFlight.current.has(p.name)) continue;
      inFlight.current.add(p.name);
      api<PeerCatalog>(`api/peer-status?peer=${encodeURIComponent(p.name)}`)
        .then(
          (catalog): PeerResult => ({ kind: 'ok', catalog }),
          (e): PeerResult => ({ kind: 'error', message: errorMessage(e) }),
        )
        .then((r) => setResults((all) => ({ ...all, [p.name]: r })))
        .finally(() => inFlight.current.delete(p.name));
    }
  }, [status.data]);

  const patch = (key: string, next: Partial<RowState>) => setRows((all) => ({ ...all, [key]: { ...all[key], ...next } }));

  const ops = {
    fetch: async (peer: string, project: string) => {
      const key = rowKey(peer, project);
      patch(key, { fetching: true });
      try {
        const state = await api<SyncState>(
          `api/sync-status?project=${encodeURIComponent(project)}&remote=${encodeURIComponent(peer)}`,
        );
        patch(key, { result: { kind: 'state', state } });
      } catch (e) {
        patch(key, { result: { kind: 'error', label: 'err', message: errorMessage(e) } });
      } finally {
        patch(key, { fetching: false });
      }
    },
    sync: async (peer: string, project: string) => {
      const key = rowKey(peer, project);
      patch(key, { syncing: true });
      try {
        const state = await post<SyncState>('api/sync', { project, remote: peer });
        patch(key, { result: { kind: 'state', state } });
      } catch (e) {
        patch(key, { result: { kind: 'error', label: 'sync failed', message: errorMessage(e) } });
      } finally {
        patch(key, { syncing: false });
      }
    },
    clone: async (peer: string, project: string) => {
      const key = rowKey(peer, project);
      patch(key, { cloning: true, result: undefined });
      try {
        await post('api/clone', { peer, project });
        await refreshAll(); // the project is now local, so its row becomes a Sync row
      } catch (e) {
        patch(key, { result: { kind: 'error', label: 'clone failed', message: errorMessage(e) } });
      } finally {
        patch(key, { cloning: false });
      }
    },
  };

  const s = status.data;
  return (
    <Section title="Connected Peers">
      {!s ? (
        status.error ? (
          <SectionState state="error" message={status.error} onRetry={status.refresh} />
        ) : (
          <SectionState state="loading" />
        )
      ) : !s.peers.length ? (
        <SectionState state="empty" text="No peers connected." />
      ) : (
        <ul className="space-y-3">
          {s.peers.map((p) => (
            <PeerItem key={p.name} peer={p} registry={s.shared} result={results[p.name] ?? { kind: 'pending' }} rows={rows} ops={ops} />
          ))}
        </ul>
      )}
    </Section>
  );
}

type Ops = Record<'fetch' | 'sync' | 'clone', (peer: string, project: string) => Promise<void>>;

function PeerItem({
  peer,
  registry,
  result,
  rows,
  ops,
}: {
  peer: PeerRef;
  registry: SharedEntry[];
  result: PeerResult;
  rows: Record<string, RowState>;
  ops: Ops;
}) {
  const view = peerRows(peer.name, registry, result);
  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium break-all">{peer.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={peer.url}>
          {peer.url}
        </span>
      </div>
      {view.note === 'checking' && <p className="text-sm text-muted-foreground">Checking peer…</p>}
      {view.note === 'empty' && <p className="text-sm text-muted-foreground">Peer exposes no projects.</p>}
      {view.note === 'offline' && <p className="text-sm text-destructive">Offline: {view.error}</p>}
      {view.rows.length > 0 && (
        <ul className="divide-y">
          {view.rows.map((r, i) => {
            const state = rows[rowKey(peer.name, r.name)] ?? {};
            return r.kind === 'sync' ? (
              <SyncRow key={`s${i}:${r.name}`} peer={peer.name} project={r.name} state={state} ops={ops} />
            ) : (
              <CloneRow key={`c${i}:${r.name}`} peer={peer.name} project={r.name} state={state} ops={ops} />
            );
          })}
        </ul>
      )}
    </li>
  );
}

function Outcome({ state }: { state: RowState }) {
  const r = state.result;
  if (!r) return null;
  if (r.kind === 'state') {
    const b = syncBadge(r.state);
    return <Badge variant={b.variant}>{b.label}</Badge>;
  }
  return (
    <>
      <Badge variant="destructive">{r.label}</Badge>
      <ErrorDetails message={r.message} />
    </>
  );
}

function SyncRow({ peer, project, state, ops }: { peer: string; project: string; state: RowState; ops: Ops }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-2">
        <Badge variant="success" className="max-w-full truncate">
          {project}
        </Badge>
        {state.syncing ? <span className="text-xs text-muted-foreground">syncing…</span> : <Outcome state={state} />}
      </div>
      <div className="flex gap-2">
        <ActionButton
          type="button"
          variant="outline"
          size="sm"
          busy={state.fetching}
          aria-label={`Fetch ${project} from ${peer}`}
          onClick={() => ops.fetch(peer, project)}
        >
          {state.fetching ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
          Fetch
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          size="sm"
          busy={state.syncing}
          aria-label={`Sync ${project} with ${peer}`}
          onClick={() => ops.sync(peer, project)}
        >
          {state.syncing ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpDownIcon />}
          Sync
        </ActionButton>
      </div>
    </li>
  );
}

function CloneRow({ peer, project, state, ops }: { peer: string; project: string; state: RowState; ops: Ops }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-2">
        <Badge variant="secondary" className="max-w-full truncate">
          {project}
        </Badge>
        <span className="text-xs text-muted-foreground">peer only</span>
        {state.cloning ? <span className="text-xs text-muted-foreground">cloning…</span> : <Outcome state={state} />}
      </div>
      <ActionButton
        type="button"
        variant="outline"
        size="sm"
        busy={state.cloning}
        aria-label={`Clone ${project} from ${peer}`}
        onClick={() => ops.clone(peer, project)}
      >
        {state.cloning ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
        Clone
      </ActionButton>
    </li>
  );
}
