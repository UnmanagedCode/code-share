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
  const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(api('api/status')).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledWith('api/status', undefined);
  await expect(api('api/share', { method: 'POST', body: '{"a":1}' })).resolves.toEqual({ ok: true });
  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe('api/share');
  expect(init).toMatchObject({ method: 'POST', body: '{"a":1}' });
});

// Invariant: every request other than GET/HEAD declares application/json, body or not (the backend refuses a
// state-changing request without it); a caller's own Content-Type is kept, and GET sends none.
it('declares JSON on every state-changing request', async () => {
  const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => json(200, {}));
  vi.stubGlobal('fetch', fetchMock);
  await api('api/tunnel/stop', { method: 'POST' });
  await api('api/x', { method: 'delete' });
  await api('api/share', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{}' });
  await api('api/status', { method: 'GET' });
  const typeOf = (i: number) => new Headers(fetchMock.mock.calls[i][1]?.headers).get('Content-Type');
  expect([typeOf(0), typeOf(1), typeOf(2), typeOf(3)]).toEqual(['application/json', 'application/json', 'application/json; charset=utf-8', null]);
  expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
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
