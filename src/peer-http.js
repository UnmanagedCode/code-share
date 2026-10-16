'use strict';
// The one way code-share talks HTTP to a peer: Basic auth with the peer's
// token, a deadline on the whole exchange, and a cap on the reply size, so a
// peer that stalls or floods can never hold a request (or memory) forever.
const http = require('http');
const https = require('https');
const { LIMITS } = require('./limits');

/**
 * `method` `url` with optional JSON `body`; resolves the parsed JSON reply (or its text when not JSON).
 * Rejects on an HTTP status >= 400 (`HTTP <status>: <body>`), on the deadline, and on an oversized reply.
 */
function peerRequest(url, { method = 'GET', body, token, timeoutMs = LIMITS.PEER_HTTP_TIMEOUT_MS, maxBytes = LIMITS.PEER_RESPONSE_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error(`Invalid peer URL: ${url}`)); return; }
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Authorization': `Basic ${Buffer.from(`x:${token}`).toString('base64')}` };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const mod = u.protocol === 'https:' ? https : http;
    let req;
    try {
      req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method,
        headers,
      });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      req.destroy(new Error(`Peer did not answer within ${Math.round(timeoutMs / 1000)}s: ${method} ${u.origin}${u.pathname}`));
    }, timeoutMs);
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error(`Peer reply larger than ${maxBytes} bytes: ${method} ${u.origin}${u.pathname}`));
          return;
        }
        chunks.push(c);
      });
      res.on('error', () => {}); // reported through req's 'error'
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${text.trim()}`)); return; }
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(payload === null ? undefined : payload);
  });
}

module.exports = { peerRequest };
