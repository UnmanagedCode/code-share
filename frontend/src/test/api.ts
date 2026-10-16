import { vi } from 'vitest';
import type { ProjectRow, Status } from '@/lib/types';

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A backend error as src/webui.js sends it. */
export const fail = (status: number, error: string) => json(status, { error });

export type Handler = (url: string, init?: RequestInit) => unknown;
export interface Call {
  method: string;
  url: string;
  body?: unknown;
  rawBody?: unknown;
  headers: Headers;
}

/**
 * Stubs `fetch` with a route table keyed `"<METHOD> <url>"` (exact, or without the query). A value is the
 * JSON body of a 200; a function returns that, a Response, or a promise of either. Unknown routes are a 404.
 * `routes` stays mutable, so a test can change an answer between polls.
 */
export function stubApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const rawBody = init?.body;
    calls.push({ method, url, rawBody, headers: new Headers(init?.headers), body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined });
    const h = routes[`${method} ${url}`] ?? routes[`${method} ${url.split('?')[0]}`];
    if (h === undefined) return fail(404, `no stub for ${method} ${url}`);
    const v = typeof h === 'function' ? await (h as Handler)(url, init) : h;
    return v instanceof Response ? v : json(200, v);
  });
  vi.stubGlobal('fetch', fetchMock);
  const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.split('?')[0] === path).length;
  return { routes, calls, fetchMock, count };
}

/** A promise a test settles by hand, to hold a request in flight. */
export function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const TOKEN = '3f9a0c1e2b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4';

export function makeStatus(over: Partial<Status> = {}): Status {
  return {
    token: TOKEN,
    selfUrl: `http://x:${TOKEN}@192.168.1.20:9419`,
    tunnelUrl: null,
    tunnelStarting: false,
    projectsRoot: '/srv/projects',
    shared: [],
    peers: [],
    ...over,
  };
}

export const project = (name: string, shared = false): ProjectRow => ({ name, path: `/srv/projects/${name}`, shared });

/** The routes every page load makes, answering `status` and `projects`. */
export function baseRoutes(status: Status = makeStatus(), projects: ProjectRow[] = []) {
  return { 'GET api/status': status, 'GET api/projects': projects } as Record<string, unknown>;
}
