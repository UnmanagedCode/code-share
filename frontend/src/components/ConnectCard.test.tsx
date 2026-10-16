import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import vectors from '@/test/cs1-vector.json';
import { baseRoutes, deferred, fail, stubApi } from '@/test/api';

afterEach(() => vi.unstubAllGlobals());
const card = () => screen.getByRole('region', { name: 'Connect a Peer' });
const csInput = () => within(card()).getByLabelText("Connection string (paste peer's cs1:… string)") as HTMLInputElement;
const nameInput = () => within(card()).getByLabelText('Peer name (local label)') as HTMLInputElement;
const posted = (api: ReturnType<typeof stubApi>) => api.calls.filter((c) => c.url === 'api/connect').map((c) => c.body);

// Invariant: the inputs are labelled (cs1 placeholder, name defaults to "peer"), and Enter submits the form.
it('submits on Enter with the cs1 url and token', async () => {
  const api = stubApi({ ...baseRoutes(), 'POST api/connect': { ok: true } });
  const user = userEvent.setup();
  render(<App />);
  expect(csInput().placeholder).toBe('cs1:…');
  expect(nameInput().value).toBe('peer');
  const v = vectors[0];
  await user.type(csInput(), `${v.expected}{Enter}`);
  await waitFor(() => expect(posted(api)).toEqual([{ url: 'http://192.168.1.20:9419', token: v.token, name: 'peer' }]));
});

// Invariant: the two validation messages, with nothing sent.
it('validates before sending', async () => {
  const api = stubApi(baseRoutes());
  const user = userEvent.setup();
  render(<App />);
  await user.click(within(card()).getByRole('button', { name: 'Connect' }));
  expect(within(card()).getByRole('alert').textContent).toBe('Connection string is required');
  await user.type(csInput(), 'not a link{Enter}');
  expect(within(card()).getByRole('alert').textContent).toBe("Invalid connection string — paste the cs1:… value from the peer's UI");
  expect(posted(api)).toEqual([]);
});

// Invariant: a plain URL's password is the token, credentials and trailing slash are stripped, the name is
// trimmed, and an empty name falls back to "peer".
it('sends a plain authed URL', async () => {
  const api = stubApi({ ...baseRoutes(), 'POST api/connect': { ok: true } });
  const user = userEvent.setup();
  render(<App />);
  await user.type(csInput(), 'http://x:secret@10.0.0.7:19419/');
  await user.clear(nameInput());
  await user.type(nameInput(), '  laptop {Enter}');
  await user.type(csInput(), 'http://x:s2@10.0.0.8:1/');
  await user.clear(nameInput());
  await user.click(within(card()).getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(posted(api)).toEqual([
    { url: 'http://10.0.0.7:19419', token: 'secret', name: 'laptop' },
    { url: 'http://10.0.0.8:1', token: 's2', name: 'peer' },
  ]));
});

// Invariant: while connecting the button is aria-disabled and reads "Connecting…"; success clears the string (it holds a
// token), says "Connected!…" and reloads; an error reads "Error: <msg>" and keeps the input.
it('busy, success and error', async () => {
  const gate = deferred<Response | object>();
  const api = stubApi({ ...baseRoutes(), 'POST api/connect': () => gate.promise });
  const user = userEvent.setup();
  render(<App />);
  await user.type(csInput(), `${vectors[0].expected}{Enter}`);
  const busy = within(card()).getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement;
  expect(busy.getAttribute('aria-disabled')).toBe('true');
  await act(async () => gate.resolve({ ok: true }));
  await within(card()).findByText('Connected! Toggle the Leader checkbox per project if needed.');
  expect(csInput().value).toBe('');
  await waitFor(() => expect(api.count('GET', 'api/status')).toBe(2));

  api.routes['POST api/connect'] = fail(500, 'Handshake failed: HTTP 401');
  await user.type(csInput(), `${vectors[0].expected}{Enter}`);
  expect((await within(card()).findByRole('alert')).textContent).toBe('Error: Handshake failed: HTTP 401');
  expect(csInput().value).toBe(vectors[0].expected);
});
