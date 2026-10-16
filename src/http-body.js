'use strict';
// Request bodies the servers read into memory: capped, and on the web UI
// server only ever JSON-typed (a cross-site page can send text/plain with no
// CORS preflight, never application/json).
const { LIMITS } = require('./limits');

class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Reads the whole body as UTF-8; rejects with a 413 BodyError once it is (or declares itself) larger than `maxBytes`. */
function readBody(req, maxBytes = LIMITS.REQUEST_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new BodyError(413, `Request body larger than ${maxBytes} bytes`);
    if (Number(req.headers['content-length']) > maxBytes) { reject(tooLarge()); return; }
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.off('data', onData);
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Whether a failed body read means the client went away (an abort or reset), which needs no stack trace. */
function clientGone(req, res, err) {
  return req.destroyed || res.destroyed || (err && (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.message === 'aborted'));
}

/** Whether the request declares a JSON body: `application/json`, parameters (charset) allowed, any case. */
function isJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/**
 * Sends a JSON error and closes the connection, without reading what remains of the body: the request is
 * destroyed once the reply has gone out.
 */
function refuse(req, res, status, error) {
  const body = JSON.stringify({ error });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' });
  res.end(body, () => req.destroy());
}

module.exports = { BodyError, readBody, isJson, refuse, clientGone };
