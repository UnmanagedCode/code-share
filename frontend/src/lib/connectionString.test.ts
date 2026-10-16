import { describe, expect, it } from 'vitest';
import vectors from '../test/cs1-vector.json';
import { decodePayload, makeConnectionString, parseConnectionString, parsePeerInput, qrTextFor } from './connectionString';

const bare = (base: string) => {
  const u = new URL(base);
  u.username = '';
  u.password = '';
  return u.toString().replace(/\/$/, '');
};

describe('makeConnectionString', () => {
  // Invariant: the UI builds the same bytes as buildConnectionString in src/peer.js (shared vector,
  // including base64url's - and _, no padding, and a UTF-8 token).
  it('matches the shared vector', () => {
    for (const v of vectors) expect(makeConnectionString(v.base, v.token)).toBe(v.expected);
  });

  // Invariant: no URL (status has neither tunnel nor LAN URL) or an unparsable one gives no string.
  it('is null without a usable URL', () => {
    expect(makeConnectionString(null, 't')).toBeNull();
    expect(makeConnectionString('', 't')).toBeNull();
    expect(makeConnectionString('not a url', 't')).toBeNull();
  });
});

describe('parseConnectionString / decodePayload', () => {
  // Invariant: a cs1 string round-trips to the credential-free URL and the token.
  it('round-trips', () => {
    for (const v of vectors) {
      expect(parseConnectionString(v.expected)).toEqual({ url: bare(v.base), token: v.token });
      expect(decodePayload(v.expected.slice(4))).toEqual({ url: bare(v.base), token: v.token });
    }
  });

  // Invariant: anything that is not a decodable cs1 string is null, never a throw.
  it('rejects what it cannot decode', () => {
    expect(parseConnectionString('')).toBeNull();
    expect(parseConnectionString('http://x:t@h:1')).toBeNull();
    expect(parseConnectionString('cs1:%%%')).toBeNull();
    expect(parseConnectionString('cs1:' + btoa('not json'))).toBeNull();
    expect(decodePayload('%%%')).toBeNull();
    expect(decodePayload('')).toBeNull();
  });

  // Invariant: the connect page needs both fields; a payload missing either is unreadable.
  it('decodePayload requires url and token', () => {
    const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, '');
    expect(decodePayload(enc({ url: 'http://h:1' }))).toBeNull();
    expect(decodePayload(enc({ token: 't' }))).toBeNull();
    expect(decodePayload(enc(null))).toBeNull();
    expect(decodePayload(enc({ url: 'http://h:1', token: 't' }))).toEqual({ url: 'http://h:1', token: 't' });
  });
});

describe('qrTextFor', () => {
  // Invariant: the QR opens <peer url>/connect#<payload>, so the token stays in the fragment.
  it('points at the peer connect page with the payload in the fragment', () => {
    for (const v of vectors) expect(qrTextFor(v.expected)).toBe(`${bare(v.base)}/connect#${v.expected.slice(4)}`);
  });

  // Invariant: trailing slashes on the payload URL are dropped; text that is not a usable cs1 string passes through.
  it('strips trailing slashes and passes other text through', () => {
    const payload = btoa(JSON.stringify({ url: 'https://h.example//', token: 't' })).replace(/=/g, '');
    expect(qrTextFor('cs1:' + payload)).toBe(`https://h.example/connect#${payload}`);
    expect(qrTextFor('hello')).toBe('hello');
    expect(qrTextFor('cs1:%%%')).toBe('cs1:%%%');
    const noUrl = 'cs1:' + btoa(JSON.stringify({ token: 't' }));
    expect(qrTextFor(noUrl)).toBe(noUrl);
  });
});

describe('parsePeerInput', () => {
  // Invariant: the Connect form's parse order: cs1 first, then a URL whose password is the token.
  it('reads a cs1 string', () => {
    const v = vectors[0];
    expect(parsePeerInput(`  ${v.expected} `)).toEqual({ ok: true, url: bare(v.base), token: v.token });
  });

  it('reads a plain URL with an embedded password, stripping credentials and the trailing slash', () => {
    expect(parsePeerInput('http://x:secret@192.168.1.20:9419/')).toEqual({ ok: true, url: 'http://192.168.1.20:9419', token: 'secret' });
    expect(parsePeerInput('http://192.168.1.20:9419')).toEqual({ ok: true, url: 'http://192.168.1.20:9419', token: undefined });
  });

  // Invariant: the two validation messages, verbatim.
  it('reports empty and invalid input', () => {
    expect(parsePeerInput('   ')).toEqual({ ok: false, error: 'Connection string is required' });
    expect(parsePeerInput('garbage')).toEqual({ ok: false, error: "Invalid connection string — paste the cs1:… value from the peer's UI" });
  });
});
