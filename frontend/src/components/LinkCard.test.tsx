import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { QrCode } from './QrCode';
import { makeConnectionString, qrTextFor } from '@/lib/connectionString';
import { baseRoutes, deferred, fail, makeStatus, stubApi, TOKEN } from '@/test/api';

afterEach(() => vi.unstubAllGlobals());
const card = () => screen.getByRole('region', { name: 'Your Link' });
const button = (name: RegExp | string) => within(card()).getByRole('button', { name });
const TUNNEL = 'https://quiet-river-1234.trycloudflare.com';

// Invariant: the URLs and the cs1 string (built from the tunnel URL, else the LAN URL) show as text; a missing
// value reads "—" with its Copy disabled.
it('shows the values, with Copy disabled on "—"', async () => {
  const s = makeStatus();
  stubApi(baseRoutes(s));
  render(<App />);
  await within(card()).findByText('serving');
  expect(within(card()).getByText(s.selfUrl!)).toBeTruthy();
  expect(within(card()).getByText(makeConnectionString(s.selfUrl, TOKEN)!)).toBeTruthy();
  expect((button('Copy LAN URL') as HTMLButtonElement).disabled).toBe(false);
  expect((button('Copy Tunnel URL') as HTMLButtonElement).disabled).toBe(true);
  expect(within(card()).getAllByText('—')).toHaveLength(1);
});

// Invariant: with neither URL there is no cs1 string: a muted hint, and Copy and Show QR disabled.
it('no URL: no connection string, Copy and QR disabled', async () => {
  stubApi(baseRoutes(makeStatus({ selfUrl: null })));
  render(<App />);
  await within(card()).findByText('— (start tunnel or connect LAN first)');
  expect((button('Copy Connection') as HTMLButtonElement).disabled).toBe(true);
  expect((button('Show QR') as HTMLButtonElement).disabled).toBe(true);
});

// Invariant: Copy writes exactly the shown value and says "Copied".
it('Copy copies the shown value', async () => {
  stubApi(baseRoutes(makeStatus({ tunnelUrl: TUNNEL })));
  const user = userEvent.setup();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<App />);
  await within(card()).findByText(TUNNEL);
  await user.click(button('Copy Connection'));
  expect(writeText).toHaveBeenCalledWith(makeConnectionString(TUNNEL, TOKEN));
  expect(within(card()).getAllByRole('button', { name: 'Copied' })).toHaveLength(1);
});

// Invariant: Start tunnel posts {type:"cloudflared"}, is aria-disabled with "Starting… (up to 30s)" while in flight,
// then reloads status, after which a tunnel URL turns it into Stop tunnel.
it('starts a tunnel', async () => {
  const start = deferred();
  const api = stubApi({ ...baseRoutes(), 'POST api/tunnel/start': () => start.promise });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await within(card()).findByRole('button', { name: 'Start tunnel' }));
  const busy = button('Starting… (up to 30s)') as HTMLButtonElement;
  expect(busy.getAttribute('aria-disabled')).toBe('true');
  expect(api.calls.find((c) => c.url === 'api/tunnel/start')?.body).toEqual({ type: 'cloudflared' });
  api.routes['GET api/status'] = makeStatus({ tunnelUrl: TUNNEL });
  await act(async () => start.resolve({ ok: true }));
  await within(card()).findByRole('button', { name: 'Stop tunnel' });
  expect(api.count('GET', 'api/status')).toBe(2);
});

// Invariant: a start already in progress on the backend (tunnelStarting) shows the busy (aria-disabled) state.
it('shows tunnelStarting as busy', async () => {
  stubApi(baseRoutes(makeStatus({ tunnelStarting: true })));
  render(<App />);
  const b = (await within(card()).findByRole('button', { name: 'Starting… (up to 30s)' })) as HTMLButtonElement;
  expect(b.getAttribute('aria-disabled')).toBe('true');
});

// Invariant: Stop tunnel is destructive, posts with no body, and reads "Stopping…" (aria-disabled) while in flight.
it('stops a tunnel', async () => {
  const stop = deferred();
  const api = stubApi({ ...baseRoutes(makeStatus({ tunnelUrl: TUNNEL })), 'POST api/tunnel/stop': () => stop.promise });
  const user = userEvent.setup();
  render(<App />);
  const b = await within(card()).findByRole('button', { name: 'Stop tunnel' });
  expect(b.className).toContain('bg-destructive');
  await user.click(b);
  expect(button('Stopping…').getAttribute('aria-disabled')).toBe('true');
  expect(api.calls.find((c) => c.url === 'api/tunnel/stop')?.rawBody).toBeUndefined();
  api.routes['GET api/status'] = makeStatus();
  await act(async () => stop.resolve({ ok: true }));
  await within(card()).findByRole('button', { name: 'Start tunnel' });
});

// Invariant: a tunnel error shows inline as an alert, and the button returns to idle.
it('shows a tunnel error inline', async () => {
  stubApi({ ...baseRoutes(), 'POST api/tunnel/start': fail(400, 'cloudflared not found') });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await within(card()).findByRole('button', { name: 'Start tunnel' }));
  expect((await within(card()).findByRole('alert')).textContent).toBe('cloudflared not found');
  expect(button('Start tunnel')).toBeTruthy();
});

// Invariant: Show QR toggles a panel (aria-expanded/aria-controls) holding the QR of qrTextFor(cs), and the panel
// closes when the connection string disappears.
it('QR toggle', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const s = makeStatus();
  const api = stubApi(baseRoutes(s));
  const user = userEvent.setup();
  render(<App />);
  const toggle = await within(card()).findByRole('button', { name: 'Show QR' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await user.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.textContent).toBe('Hide QR');
  const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(panel.hidden).toBe(false);
  const d = panel.querySelector('svg path')?.getAttribute('d');
  const expected = render(<QrCode text={qrTextFor(makeConnectionString(s.selfUrl, TOKEN)!)} />);
  expect(d).toBe(expected.container.querySelector('path')?.getAttribute('d'));
  expected.unmount();

  api.routes['GET api/status'] = makeStatus({ selfUrl: null });
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
  expect(panel.hidden).toBe(true);
  expect(panel.querySelector('svg')).toBeNull();
  expect((toggle as HTMLButtonElement).disabled).toBe(true);
  vi.useRealTimers();
});
