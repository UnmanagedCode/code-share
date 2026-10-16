'use strict';
// Bounds on everything that waits on, or buffers, another party. One mutable
// object so tests can shorten a deadline (and restore it) without real waits.
const LIMITS = {
  // A git command (fetch, clone, merge, …): killed when it runs longer than this.
  GIT_TIMEOUT_MS: 15 * 60_000,
  // A git transfer that moves less than 1 byte/s for this long is aborted by git itself.
  GIT_STALL_SECONDS: 60,
  // One HTTP call to a peer (register, status): the whole exchange, connect to last byte.
  PEER_HTTP_TIMEOUT_MS: 15_000,
  // The largest peer reply read into memory.
  PEER_RESPONSE_MAX_BYTES: 1024 * 1024,
  // The largest request body either server reads into memory (web UI API, /control/register).
  REQUEST_BODY_MAX_BYTES: 1024 * 1024,
};

module.exports = { LIMITS };
