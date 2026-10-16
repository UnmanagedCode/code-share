import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import vectors from './test/cs1-vector.json';
import { ConnectPage } from './ConnectPage';

const cs = vectors[0].expected;
const setHash = (h: string) => history.replaceState(null, '', `/connect${h}`);
const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setHash('');
  window.getSelection()?.removeAllRanges();
});

// Invariant: before the fragment is read, the page says it is reading.
it('shows the loading state first', () => {
  setHash(`#${cs.slice(4)}`);
  expect(renderToStaticMarkup(<ConnectPage />)).toContain('Reading connection data…');
});

// Invariant: a link with no fragment says so.
it('no hash: says there is no connection data', () => {
  setHash('');
  render(<ConnectPage />);
  expect(screen.getByRole('alert').textContent).toBe('No connection data in this link.');
});

// Invariant: an undecodable fragment, or one missing url or token, is reported as unreadable.
it('bad hash: says the data cannot be read', () => {
  for (const h of ['#%%%', `#${btoa(JSON.stringify({ url: 'http://h:1' }))}`, `#${btoa(JSON.stringify({ token: 't' }))}`]) {
    setHash(h);
    const { unmount } = render(<ConnectPage />);
    expect(screen.getByRole('alert').textContent).toBe('Could not read connection data from this link.');
    unmount();
  }
});

// Invariant: a valid link shows the instruction (Connect strong, "your own" emphasised) and the cs1 string as
// text, and connects nothing: no request is made.
it('valid hash: shows the cs1 string and the instructions, and makes no request', () => {
  setHash(`#${cs.slice(4)}`);
  const { container } = render(<ConnectPage />);
  expect(screen.getByText(cs)).toBeTruthy();
  expect(container.querySelector('strong')?.textContent).toBe('Connect');
  expect(container.querySelector('em')?.textContent).toBe('your own');
  expect(container.textContent).toContain('Scanning this code does not connect anything automatically.');
  expect(fetchMock).not.toHaveBeenCalled();
});

// Invariant: Copy writes exactly the cs1 string and reports "Copied".
it('Copy copies the string', async () => {
  setHash(`#${cs.slice(4)}`);
  const user = userEvent.setup();
  const writeText = vi.fn(async () => {});
  setClipboard({ writeText });
  render(<ConnectPage />);
  await user.click(screen.getByRole('button', { name: /copy/i }));
  expect(writeText).toHaveBeenCalledWith(cs);
  expect(screen.getByRole('button').textContent).toBe('Copied');
  expect(screen.getByRole('status').textContent).toBe('Copied');
});

// Invariant: without a Clipboard API (plain-http LAN) or when it refuses, the cs1 text is selected for a manual
// copy and the button says so.
it('Copy falls back to selecting the text', async () => {
  for (const clipboard of [undefined, { writeText: vi.fn(async () => { throw new Error('denied'); }) }]) {
    setHash(`#${cs.slice(4)}`);
    const user = userEvent.setup();
    setClipboard(clipboard);
    const { unmount } = render(<ConnectPage />);
    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(screen.getByRole('button').textContent).toBe("Couldn't copy — text selected");
    expect(window.getSelection()?.toString()).toBe(cs);
    unmount();
    window.getSelection()?.removeAllRanges();
  }
});

// Invariant: markup inside the payload never becomes elements.
it('renders a hostile payload as text', () => {
  const payload = btoa(JSON.stringify({ url: '<img src=x onerror=alert(1)>', token: '<script>alert(1)</script>' })).replace(/=/g, '');
  setHash(`#${payload}`);
  const { container } = render(<ConnectPage />);
  expect(screen.getByText(`cs1:${payload}`)).toBeTruthy();
  expect(container.querySelector('img, script')).toBeNull();
});
