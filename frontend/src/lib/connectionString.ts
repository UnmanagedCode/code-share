// The `cs1:` connection string: `cs1:` + base64url(JSON {url, token}), unpadded.
// makeConnectionString must stay byte-identical to buildConnectionString in
// src/peer.js (tests/connection-string.test.mjs and connectionString.test.ts
// share one vector), so both sides encode the JSON as UTF-8.

export interface ConnectionData {
  url: string;
  token: string;
}

function toBase64Url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Decodes a base64url (padded or not) UTF-8 JSON payload. Throws on anything malformed. */
function fromBase64UrlJson(payload: string): unknown {
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/** The `cs1:` string for a URL (credentials stripped, no trailing `/`) and token; null when there is no URL. */
export function makeConnectionString(rawUrl: string | null | undefined, token: string): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    u.username = '';
    u.password = '';
    const bare = u.toString().replace(/\/$/, '');
    return 'cs1:' + toBase64Url(JSON.stringify({ url: bare, token }));
  } catch {
    return null;
  }
}

/** The decoded JSON of a `cs1:` string, whatever its fields; null when `s` is not a decodable `cs1:` string. */
export function parseConnectionString(s: string): Partial<ConnectionData> | null {
  if (!s || !s.startsWith('cs1:')) return null;
  try {
    return (fromBase64UrlJson(s.slice(4)) as Partial<ConnectionData> | null) ?? null;
  } catch {
    return null;
  }
}

/** A connect-page fragment's `{url, token}`; null when it is undecodable or either field is missing. */
export function decodePayload(payload: string): ConnectionData | null {
  try {
    const parsed = fromBase64UrlJson(payload) as Partial<ConnectionData> | null;
    if (!parsed || !parsed.url || !parsed.token) return null;
    return { url: String(parsed.url), token: String(parsed.token) };
  } catch {
    return null;
  }
}

/** What the QR encodes: `<peer url>/connect#<payload>` for a `cs1:` string, so a phone opens the connect page; otherwise `text`. */
export function qrTextFor(text: string): string {
  if (!text.startsWith('cs1:')) return text;
  try {
    const payload = text.slice(4);
    const peerUrl = (fromBase64UrlJson(payload) as { url?: unknown } | null)?.url;
    if (!peerUrl || typeof peerUrl !== 'string') return text;
    return peerUrl.replace(/\/+$/, '') + '/connect#' + payload;
  } catch {
    return text;
  }
}

/**
 * The Connect form's input, in its parse order: a `cs1:` string gives its url and token;
 * otherwise a URL, whose embedded password (if any) is the token and is stripped with
 * the username and a trailing `/`. Fields stay undefined where the input has none.
 */
export function parsePeerInput(
  raw: string,
): { ok: true; url?: string; token?: string } | { ok: false; error: string } {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'Connection string is required' };
  const parsed = parseConnectionString(input);
  if (parsed) return { ok: true, url: parsed.url, token: parsed.token };
  try {
    const u = new URL(input);
    let token: string | undefined;
    if (u.password) {
      token = u.password;
      u.username = '';
      u.password = '';
    }
    return { ok: true, url: u.toString().replace(/\/$/, ''), token };
  } catch {
    return { ok: false, error: "Invalid connection string — paste the cs1:… value from the peer's UI" };
  }
}
