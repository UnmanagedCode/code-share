import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Invariant: a root-relative path would reach cc's API, so it is refused before any request.
it('refuses a root-relative path', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(api('/api/status')).rejects.toThrow(/root-relative/);
  expect(fetchMock).not.toHaveBeenCalled();
});

// Invariant: a relative path is fetched as given, with the init passed through, and its JSON returned.
it('returns the JSON of a relative request', async () => {
  const fetchMock = vi.fn(async () => json(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const init = { method: 'POST', body: '{}' };
  await expect(api('api/share', init)).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledWith('api/share', init);
});

// Invariant: a failure carries the status and the backend's {error, code}; a non-JSON body falls back to `HTTP <status>`.
it('throws ApiError with the backend message, or HTTP <status>', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'Name already in use: x', code: 'DUP' })));
  const e = await api('api/share').catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e).toMatchObject({ status: 400, message: 'Name already in use: x', code: 'DUP' });

  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 502 })));
  await expect(api('api/peer-status?peer=p')).rejects.toMatchObject({ status: 502, message: 'HTTP 502', code: undefined });
});
