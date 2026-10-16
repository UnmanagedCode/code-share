import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/ActionButton';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/Section';
import { RefreshNotice, SectionState } from '@/components/SectionState';
import { api } from '@/lib/api';
import type { ProjectRow, SharedEntry, Status } from '@/lib/types';
import { errorMessage, type Polled } from '@/lib/usePoll';

const post = (path: string, body: unknown) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** "Projects": the git repos under PROJECTS_ROOT, with Share / Unshare and the per-project Leader flag. */
export function ProjectsCard({
  projects,
  status,
  refreshAll,
}: {
  projects: Polled<ProjectRow[]>;
  status: Polled<Status>;
  refreshAll: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // Leader values set here and not yet confirmed by a status refresh.
  const [leaderOverride, setLeaderOverride] = useState<Record<string, boolean>>({});
  const registry = new Map((status.data?.shared ?? []).map((e) => [e.name, e]));

  const share = async (p: ProjectRow) => {
    setError(null);
    try {
      await post('api/share', { path: p.path, name: p.name });
      await refreshAll();
    } catch (e) {
      setError(`Couldn't share ${p.name}: ${errorMessage(e)}`);
    }
  };

  const unshare = async (name: string): Promise<boolean> => {
    setError(null);
    try {
      await post('api/unshare', { name });
      await refreshAll();
      return true;
    } catch (e) {
      setError(`Couldn't unshare ${name}: ${errorMessage(e)}`);
      return false;
    }
  };

  const setLeader = async (name: string, leader: boolean) => {
    setError(null);
    setLeaderOverride((o) => ({ ...o, [name]: leader }));
    try {
      await post('api/project-leader', { name, leader });
      await status.refresh();
    } catch (e) {
      setError(`Couldn't set Leader for ${name}: ${errorMessage(e)}`);
    } finally {
      setLeaderOverride(({ [name]: _, ...rest }) => rest);
    }
  };

  const root = status.data?.projectsRoot;
  return (
    <Section
      title="Projects"
      description={
        <>
          Git repos under <span className="font-mono break-all">{root ?? 'PROJECTS_ROOT'}</span>
        </>
      }
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {projects.data ? (
        projects.data.length ? (
          <ul className="divide-y">
            {projects.data.map((p) => (
              <ProjectItem
                key={p.path}
                project={p}
                entry={registry.get(p.name)}
                leader={leaderOverride[p.name] ?? registry.get(p.name)?.leader === true}
                leaderPending={p.name in leaderOverride}
                onShare={() => share(p)}
                onUnshare={() => unshare(p.name)}
                onLeader={(v) => setLeader(p.name, v)}
              />
            ))}
          </ul>
        ) : (
          <SectionState state="empty" text="No git repos found in PROJECTS_ROOT." />
        )
      ) : projects.error ? (
        <SectionState state="error" message={projects.error} onRetry={projects.refresh} />
      ) : (
        <SectionState state="loading" />
      )}
      <RefreshNotice message={projects.refreshError} />
    </Section>
  );
}

function ProjectItem({
  project: p,
  entry,
  leader,
  leaderPending,
  onShare,
  onUnshare,
  onLeader,
}: {
  project: ProjectRow;
  entry: SharedEntry | undefined;
  leader: boolean;
  leaderPending: boolean;
  onShare: () => Promise<void>;
  onUnshare: () => Promise<boolean>;
  onLeader: (leader: boolean) => void;
}) {
  const shared = p.shared || !!entry;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const unshareRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const leaderId = useId();

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      unshareRef.current?.focus();
    }
  }, [confirming]);

  const cancel = () => {
    returnFocus.current = true;
    setConfirming(false);
  };
  const onConfirmKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      cancel();
    }
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-2 font-medium break-all">
          {p.name}
          {shared && <Badge variant="success">shared</Badge>}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground" title={p.path}>
          {p.path}
        </div>
      </div>
      {!shared ? (
        <ActionButton type="button" variant="outline" size="sm" busy={busy} aria-label={`Share ${p.name}`} onClick={() => run(onShare)}>
          {busy && <LoaderCircleIcon className="animate-spin" />}
          Share
        </ActionButton>
      ) : confirming ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm unshare ${p.name}`} onKeyDown={onConfirmKey}>
          <span className="text-sm">Unshare {p.name}?</span>
          <ActionButton ref={cancelRef} type="button" variant="ghost" size="sm" busy={busy} onClick={cancel}>
            Cancel
          </ActionButton>
          <ActionButton
            type="button"
            variant="destructive"
            size="sm"
            busy={busy}
            onClick={async () => {
              const ok = await run(onUnshare);
              if (!ok) returnFocus.current = true;
              setConfirming(false);
            }}
          >
            {busy && <LoaderCircleIcon className="animate-spin" />}
            Unshare
          </ActionButton>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            {/* Not disabled while pending: a control that becomes disabled loses keyboard focus. */}
            <Checkbox
              id={leaderId}
              checked={leader}
              aria-busy={leaderPending}
              aria-label={`Leader for ${p.name}`}
              onCheckedChange={(v) => {
                if (!leaderPending) onLeader(v === true);
              }}
            />
            <Label htmlFor={leaderId}>Leader</Label>
          </div>
          <Button ref={unshareRef} type="button" variant="outline" size="sm" aria-label={`Unshare ${p.name}`} onClick={() => setConfirming(true)}>
            Unshare
          </Button>
        </div>
      )}
    </li>
  );
}
