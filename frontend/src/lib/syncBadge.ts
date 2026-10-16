import type { SyncState } from './types';

export type BadgeVariant = 'success' | 'info' | 'warning' | 'destructive';

/** The badge for an ahead/behind state; anything unrecognised reads as diverged. */
export function syncBadge({ state, ahead, behind }: SyncState): { variant: BadgeVariant; label: string } {
  if (state === 'in-sync') return { variant: 'success', label: '✓ in sync' };
  if (state === 'local-ahead') return { variant: 'info', label: `↑${ahead} ahead` };
  if (state === 'remote-ahead') return { variant: 'warning', label: `↓${behind} behind` };
  return { variant: 'destructive', label: `↕ diverged (↑${ahead} ↓${behind})` };
}
