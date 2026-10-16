/** A failed request: the HTTP status, and the backend's `{error, code}` body when it sent one. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

/**
 * A JSON request to this plugin's own backend. `path` is relative: a `/`-led path would reach cc's API.
 * Every request other than GET/HEAD says `Content-Type: application/json`, body or not: the backend refuses
 * a state-changing request without it (a cross-site page cannot send it without a CORS preflight).
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path.startsWith('/')) throw new Error(`api('${path}'): root-relative, so it would reach cc, not this plugin`);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const headers = new Headers(init?.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    init = { ...init, headers };
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const body: { error?: unknown; code?: unknown } | null = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  return (await res.json()) as T;
}
