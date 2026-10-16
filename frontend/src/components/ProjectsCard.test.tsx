import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { baseRoutes, deferred, fail, makeStatus, project, stubApi } from '@/test/api';

afterEach(() => vi.unstubAllGlobals());
const card = () => screen.getByRole('region', { name: 'Projects' });
const sharedAlpha = (leader = false) => makeStatus({ shared: [{ name: 'alpha', path: '/srv/projects/alpha', leader, peers: [] }] });

// Invariant: each repo shows its name, a "shared" badge when the scan or the registry says so, and its path in
// full in `title`; the description names PROJECTS_ROOT from status.
it('lists repos with their shared state', async () => {
  stubApi(baseRoutes(sharedAlpha(), [project('alpha'), project('beta', true), project('gamma')]));
  render(<App />);
  await within(card()).findByText('/srv/projects/gamma');
  expect(within(card()).getAllByText('shared')).toHaveLength(2);
  expect(within(card()).getByText('/srv/projects/alpha').getAttribute('title')).toBe('/srv/projects/alpha');
  await within(card()).findByText('/srv/projects');
  expect(within(card()).getByRole('button', { name: 'Share gamma' })).toBeTruthy();
  expect(within(card()).queryByRole('button', { name: 'Share alpha' })).toBeNull();
});

// Invariant: no repos reads "No git repos found in PROJECTS_ROOT."
it('empty', async () => {
  stubApi(baseRoutes());
  render(<App />);
  await within(card()).findByText('No git repos found in PROJECTS_ROOT.');
});

// Invariant: Share posts {path, name}, shows busy, then reloads status and projects; a failure shows inline,
// naming the project.
it('shares a repo', async () => {
  const gate = deferred();
  const api = stubApi({ ...baseRoutes(makeStatus(), [project('gamma')]), 'POST api/share': () => gate.promise });
  const user = userEvent.setup();
  render(<App />);
  const b = await within(card()).findByRole('button', { name: 'Share gamma' });
  await user.click(b);
  expect(b.getAttribute('aria-disabled')).toBe('true');
  expect(api.calls.find((c) => c.url === 'api/share')?.body).toEqual({ path: '/srv/projects/gamma', name: 'gamma' });
  await act(async () => gate.resolve({ ok: true }));
  await waitFor(() => expect(api.count('GET', 'api/projects')).toBe(2));
  expect(api.count('GET', 'api/status')).toBe(2);

  api.routes['POST api/share'] = fail(400, 'Not a git repo');
  await user.click(within(card()).getByRole('button', { name: 'Share gamma' }));
  expect((await within(card()).findByRole('alert')).textContent).toBe("Couldn't share gamma: Not a git repo");
});

// Invariant: Unshare asks inline first (Cancel focused), Cancel and Esc back out with focus returned to Unshare and
// nothing sent; confirming posts {name} and reloads.
it('confirms Unshare inline', async () => {
  const api = stubApi({ ...baseRoutes(sharedAlpha(), [project('alpha', true)]), 'POST api/unshare': { ok: true } });
  const user = userEvent.setup();
  render(<App />);
  const unshare = await within(card()).findByRole('button', { name: 'Unshare alpha' });

  await user.click(unshare);
  expect(within(card()).getByText('Unshare alpha?')).toBeTruthy();
  expect(document.activeElement?.textContent).toBe('Cancel');
  await user.click(within(card()).getByRole('button', { name: 'Cancel' }));
  expect(within(card()).queryByText('Unshare alpha?')).toBeNull();
  expect(document.activeElement).toBe(within(card()).getByRole('button', { name: 'Unshare alpha' }));

  await user.click(within(card()).getByRole('button', { name: 'Unshare alpha' }));
  await user.keyboard('{Escape}');
  expect(within(card()).queryByText('Unshare alpha?')).toBeNull();
  expect(document.activeElement).toBe(within(card()).getByRole('button', { name: 'Unshare alpha' }));
  expect(api.count('POST', 'api/unshare')).toBe(0);

  await user.click(within(card()).getByRole('button', { name: 'Unshare alpha' }));
  const confirm = within(card()).getByRole('button', { name: 'Unshare' });
  expect(confirm.className).toContain('bg-destructive');
  await user.click(confirm);
  expect(api.calls.find((c) => c.url === 'api/unshare')?.body).toEqual({ name: 'alpha' });
  await waitFor(() => expect(api.count('GET', 'api/projects')).toBe(2));
});

// Invariant: a failed Unshare shows inline, naming the project.
it('reports an Unshare failure', async () => {
  stubApi({ ...baseRoutes(sharedAlpha(), [project('alpha', true)]), 'POST api/unshare': fail(400, 'Not shared: alpha') });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await within(card()).findByRole('button', { name: 'Unshare alpha' }));
  await user.click(within(card()).getByRole('button', { name: 'Unshare' }));
  expect((await within(card()).findByRole('alert')).textContent).toBe("Couldn't unshare alpha: Not shared: alpha");
});

// Invariant: the Leader box reflects the registry, flips at once when clicked (posting {name, leader}), and
// reverts with an inline error when the backend refuses.
it('toggles Leader optimistically and reverts on error', async () => {
  const gate = deferred<Response>();
  const api = stubApi({ ...baseRoutes(sharedAlpha(false), [project('alpha', true)]), 'POST api/project-leader': () => gate.promise });
  const user = userEvent.setup();
  render(<App />);
  const box = await within(card()).findByRole('checkbox', { name: 'Leader for alpha' });
  expect(box.getAttribute('aria-checked')).toBe('false');
  await user.click(box);
  expect(box.getAttribute('aria-checked')).toBe('true');
  expect(api.calls.find((c) => c.url === 'api/project-leader')?.body).toEqual({ name: 'alpha', leader: true });
  await act(async () => gate.resolve(fail(400, 'Project not found: alpha')));
  await waitFor(() => expect(box.getAttribute('aria-checked')).toBe('false'));
  expect(within(card()).getByRole('alert').textContent).toBe("Couldn't set Leader for alpha: Project not found: alpha");
});

// Invariant: a successful Leader change stays checked through the status reload that confirms it; while it is
// pending the box keeps keyboard focus (it is not disabled) and a second toggle is ignored.
it('keeps a confirmed Leader change, and focus while pending', async () => {
  const gate = deferred();
  const api = stubApi({ ...baseRoutes(sharedAlpha(false), [project('alpha', true)]), 'POST api/project-leader': () => gate.promise });
  const user = userEvent.setup();
  render(<App />);
  const box = await within(card()).findByRole('checkbox', { name: 'Leader for alpha' });
  box.focus();
  await user.keyboard(' ');
  expect(box.getAttribute('aria-checked')).toBe('true');
  expect((box as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(box);
  await user.keyboard(' ');
  expect(box.getAttribute('aria-checked')).toBe('true');
  expect(api.count('POST', 'api/project-leader')).toBe(1);
  api.routes['GET api/status'] = sharedAlpha(true);
  await act(async () => gate.resolve({ ok: true }));
  await waitFor(() => expect(api.count('GET', 'api/status')).toBe(2));
  await waitFor(() => expect(box.getAttribute('aria-busy')).toBe('false'));
  expect(box.getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(box);
});
