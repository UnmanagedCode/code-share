import { expect, it } from 'vitest';
import { syncBadge } from './syncBadge';

// Invariant: each ahead/behind state maps to its variant and label; anything unrecognised reads as diverged.
it('maps sync states to badges', () => {
  expect(syncBadge({ state: 'in-sync', ahead: 0, behind: 0 })).toEqual({ variant: 'success', label: '✓ in sync' });
  expect(syncBadge({ state: 'local-ahead', ahead: 3, behind: 0 })).toEqual({ variant: 'info', label: '↑3 ahead' });
  expect(syncBadge({ state: 'remote-ahead', ahead: 0, behind: 2 })).toEqual({ variant: 'warning', label: '↓2 behind' });
  expect(syncBadge({ state: 'diverged', ahead: 1, behind: 4 })).toEqual({ variant: 'destructive', label: '↕ diverged (↑1 ↓4)' });
  expect(syncBadge({ state: 'something-new', ahead: 0, behind: 0 }).variant).toBe('destructive');
});
