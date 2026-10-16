import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { POLL_MS } from '@/lib/usePoll';
import type { SharedEntry } from '@/lib/types';
import { baseRoutes, deferred, fail, makeStatus, project, stubApi } from '@/test/api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const card = () => screen.getByRole('region', { name: 'Connected Peers' });
const PEER = { name: 'laptop', url: 'http://10.0.0.7:19419' };
const entry = (name: string, peers: string[] = []): SharedEntry => ({ name, path: `/srv/projects/${name}`, peers: peers.map((n) => ({ name: n })) });
const withPeer = (shared: SharedEntry[]) => makeStatus({ peers: [PEER], shared });

// Invariant: no peers reads "No peers connected."
it('empty', async () => {
  stubApi(baseRoutes());
  render(<App />);
  await within(card()).findByText('No peers connected.');
});

// Invariant: a peer shows its name and URL (title holds it in full); the wired fallback shows before the live catalog,
// which then replaces it with Sync rows for shared names and Clone rows for peer-only names.
it('wired rows first, then the live catalog', async () => {
  const catalog = deferred();
  stubApi({ ...baseRoutes(withPeer([entry('alpha', ['laptop']), entry('beta')])), 'GET api/peer-status': () => catalog.promise });
  render(<App />);
  await within(card()).findByText('laptop');
  expect(within(card()).getByText(PEER.url).getAttribute('title')).toBe(PEER.url);
  expect(within(card()).getByRole('button', { name: 'Sync alpha with laptop' })).toBeTruthy();
  expect(within(card()).queryByRole('button', { name: 'Sync beta with laptop' })).toBeNull();
  await act(async () => catalog.resolve({ shared: [{ name: 'beta' }, { name: 'delta' }] }));
  await within(card()).findByRole('button', { name: 'Clone delta from laptop' });
  expect(within(card()).getByRole('button', { name: 'Sync beta with laptop' })).toBeTruthy();
  expect(within(card()).queryByRole('button', { name: 'Sync alpha with laptop' })).toBeNull();
  expect(within(card()).getByText('peer only')).toBeTruthy();
});

// Invariant: with nothing wired, "Checking peer…" until the catalog answers; an unreachable peer then reads
// "Offline: <error>", while one with wired rows keeps them.
it('checking, then offline', async () => {
  const catalog = deferred<Response>();
  stubApi({ ...baseRoutes(withPeer([])), 'GET api/peer-status': () => catalog.promise });
  render(<App />);
  await within(card()).findByText('Checking peer…');
  await act(async () => catalog.resolve(fail(502, 'Could not reach peer: connect ECONNREFUSED')));
  await within(card()).findByText('Offline: Could not reach peer: connect ECONNREFUSED');
});

it('offline keeps wired rows', async () => {
  const api = stubApi({ ...baseRoutes(withPeer([entry('alpha', ['laptop'])])), 'GET api/peer-status': fail(502, 'Could not reach peer: x') });
  render(<App />);
  await waitFor(() => expect(api.count('GET', 'api/peer-status')).toBe(1));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(within(card()).getByRole('button', { name: 'Sync alpha with laptop' })).toBeTruthy();
  expect(within(card()).queryByText(/Offline/)).toBeNull();
  expect(within(card()).queryByText('Checking peer…')).toBeNull();
});

// Invariant: Fetch asks sync-status for (project, peer) and shows the badge; Sync posts {project, remote} with
// "syncing…" meanwhile; both badges persist across the 15 s refresh, including while the peer is re-checked.
it('Fetch and Sync badges, kept across a refresh', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const sync = deferred();
  const api = stubApi({
    ...baseRoutes(withPeer([entry('alpha', ['laptop'])]), [project('alpha', true)]),
    'GET api/peer-status': { shared: [{ name: 'alpha' }] },
    'GET api/sync-status': { state: 'remote-ahead', ahead: 0, behind: 2 },
    'POST api/sync': () => sync.promise,
  });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  await user.click(await within(card()).findByRole('button', { name: 'Fetch alpha from laptop' }));
  await within(card()).findByText('↓2 behind');
  expect(api.calls.find((c) => c.url.startsWith('api/sync-status'))?.url).toBe('api/sync-status?project=alpha&remote=laptop');

  await user.click(within(card()).getByRole('button', { name: 'Sync alpha with laptop' }));
  expect(within(card()).getByText('syncing…')).toBeTruthy();
  expect(within(card()).getByRole('button', { name: 'Sync alpha with laptop' }).getAttribute('aria-disabled')).toBe('true');
  expect(api.calls.find((c) => c.url === 'api/sync')?.body).toEqual({ project: 'alpha', remote: 'laptop' });
  await act(async () => sync.resolve({ ok: true, state: 'in-sync', ahead: 0, behind: 0 }));
  await within(card()).findByText('✓ in sync');

  const recheck = deferred();
  api.routes['GET api/peer-status'] = () => recheck.promise;
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  await waitFor(() => expect(api.count('GET', 'api/peer-status')).toBe(2));
  expect(within(card()).getByText('✓ in sync')).toBeTruthy();
  expect(within(card()).queryByText('Checking peer…')).toBeNull();
  expect(within(card()).getByRole('button', { name: 'Fetch alpha from laptop' })).toBeTruthy();
});

// Invariant: a failed Fetch reads "err" and a failed Sync "sync failed", each with the full multi-line message
// behind a Details disclosure.
it('errors expose their full text in Details', async () => {
  const conflict = 'Sync failed: Merge conflict. Aborted cleanly. Conflicting files:\n  src/a.js\n  src/b.js';
  stubApi({
    ...baseRoutes(withPeer([entry('alpha', ['laptop'])])),
    'GET api/peer-status': { shared: [{ name: 'alpha' }] },
    'GET api/sync-status': fail(500, 'fetch failed: auth'),
    'POST api/sync': fail(500, conflict),
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await within(card()).findByRole('button', { name: 'Fetch alpha from laptop' }));
  await within(card()).findByText('err');
  expect(card().querySelector('details pre')?.textContent).toBe('fetch failed: auth');
  await user.click(within(card()).getByRole('button', { name: 'Sync alpha with laptop' }));
  await within(card()).findByText('sync failed');
  const details = card().querySelector('details')!;
  expect(details.querySelector('summary')?.textContent).toBe('Details');
  expect(details.querySelector('pre')?.textContent).toBe(conflict);
  expect(details.querySelector('pre')?.className).toContain('whitespace-pre-wrap');
});

// Invariant: Clone posts {peer, project} showing "cloning…"; a failure reads "clone failed" with Details and
// re-enables the button; a success reloads, and the project becomes a Sync row.
it('clones a peer-only project', async () => {
  const gate = deferred<Response | object>();
  const api = stubApi({
    ...baseRoutes(withPeer([])),
    'GET api/peer-status': { shared: [{ name: 'delta' }] },
    'POST api/clone': () => gate.promise,
  });
  const user = userEvent.setup();
  render(<App />);
  const clone = await within(card()).findByRole('button', { name: 'Clone delta from laptop' });
  await user.click(clone);
  expect(within(card()).getByText('cloning…')).toBeTruthy();
  expect(clone.getAttribute('aria-disabled')).toBe('true');
  expect(api.calls.find((c) => c.url === 'api/clone')?.body).toEqual({ peer: 'laptop', project: 'delta' });
  await act(async () => gate.resolve(fail(400, 'Destination already exists: /srv/projects/delta')));
  await within(card()).findByText('clone failed');
  expect(card().querySelector('details pre')?.textContent).toBe('Destination already exists: /srv/projects/delta');
  expect(clone.getAttribute('aria-disabled')).toBeNull();

  api.routes['POST api/clone'] = () => {
    api.routes['GET api/status'] = withPeer([entry('delta', ['laptop'])]);
    return { ok: true };
  };
  await user.click(clone);
  await within(card()).findByRole('button', { name: 'Sync delta with laptop' });
  expect(within(card()).queryByRole('button', { name: 'Clone delta from laptop' })).toBeNull();
});
