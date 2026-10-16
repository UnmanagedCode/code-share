import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { POLL_MS } from '@/lib/usePoll';
import { baseRoutes, deferred, fail, makeStatus, project, stubApi } from '@/test/api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const region = (name: string) => screen.getByRole('region', { name });

// Invariant: sections show a loading state until their data arrives, then the data.
it('loading → data', async () => {
  const status = deferred();
  const api = stubApi({ 'GET api/status': () => status.promise, 'GET api/projects': [project('alpha')] });
  render(<App />);
  expect(within(region('Your Link')).getByText('Loading…')).toBeTruthy();
  expect(within(region('Connected Peers')).getByText('Loading…')).toBeTruthy();
  await screen.findByText('alpha');
  status.resolve(makeStatus());
  await within(region('Your Link')).findByText('serving');
  expect(api.calls.every((c) => !c.url.startsWith('/'))).toBe(true);
});

// Invariant: status and projects reload every 15 s, and every status load re-checks each connected peer.
it('polls every 15 s', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const api = stubApi({
    ...baseRoutes(makeStatus({ peers: [{ name: 'p1', url: 'http://h:1' }, { name: 'p 2', url: 'http://h:2' }] })),
    'GET api/peer-status': { shared: [] },
  });
  render(<App />);
  await screen.findAllByText('Peer exposes no projects.');
  expect([api.count('GET', 'api/status'), api.count('GET', 'api/projects'), api.count('GET', 'api/peer-status')]).toEqual([1, 1, 2]);
  expect(api.calls.filter((c) => c.url.startsWith('api/peer-status')).map((c) => c.url)).toEqual([
    'api/peer-status?peer=p1',
    'api/peer-status?peer=p%202',
  ]);
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  await waitFor(() => expect(api.count('GET', 'api/peer-status')).toBe(4));
  expect([api.count('GET', 'api/status'), api.count('GET', 'api/projects')]).toEqual([2, 2]);
});

// Invariant: a failing projects load leaves Your Link up, and Retry recovers it.
it('projects failing does not blank the other sections', async () => {
  const api = stubApi({ ...baseRoutes(), 'GET api/projects': fail(500, 'scan failed') });
  render(<App />);
  const projects = region('Projects');
  await within(projects).findByText('Error: scan failed');
  expect(within(region('Your Link')).getByText('serving')).toBeTruthy();
  api.routes['GET api/projects'] = [project('alpha')];
  await userEvent.setup().click(within(projects).getByRole('button', { name: 'Retry' }));
  await within(projects).findByText('alpha');
});

// Invariant: a failing status load leaves the projects listed, and its error shows with Retry in Your Link.
it('status failing does not blank the project list', async () => {
  stubApi({ 'GET api/status': fail(500, 'boom'), 'GET api/projects': [project('alpha', true)] });
  render(<App />);
  await within(region('Your Link')).findByText('Error: boom');
  expect(within(region('Your Link')).getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(within(region('Projects')).getByText('alpha')).toBeTruthy();
  expect(within(region('Projects')).getByText('shared')).toBeTruthy();
});

// Invariant: a refresh that fails after data loaded keeps the data on screen and says it couldn't refresh.
it('a failed refresh keeps the last data', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const api = stubApi(baseRoutes(makeStatus(), [project('alpha')]));
  render(<App />);
  await screen.findByText('alpha');
  api.routes['GET api/projects'] = fail(500, 'disk gone');
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  await within(region('Projects')).findByText("Couldn't refresh: disk gone");
  expect(screen.getByText('alpha')).toBeTruthy();
});
