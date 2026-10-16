import { useCallback } from 'react';
import { ConnectCard } from '@/components/ConnectCard';
import { LinkCard } from '@/components/LinkCard';
import { PeersCard } from '@/components/PeersCard';
import { ProjectsCard } from '@/components/ProjectsCard';
import { api } from '@/lib/api';
import type { ProjectRow, Status } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';

const loadStatus = () => api<Status>('api/status');
const loadProjects = () => api<ProjectRow[]>('api/projects');

/** The plugin UI. Status and projects load and poll independently, so one failing leaves the other's sections up. */
export function App() {
  const status = usePoll(loadStatus);
  const projects = usePoll(loadProjects);
  const refreshStatus = status.refresh;
  const refreshProjects = projects.refresh;
  const refreshAll = useCallback(
    () => Promise.all([refreshStatus(), refreshProjects()]).then(() => undefined),
    [refreshStatus, refreshProjects],
  );

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Code Share</h1>
      <LinkCard status={status} />
      <ProjectsCard projects={projects} status={status} refreshAll={refreshAll} />
      <ConnectCard refreshAll={refreshAll} />
      <PeersCard status={status} refreshAll={refreshAll} />
    </main>
  );
}
