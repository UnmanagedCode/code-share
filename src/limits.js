'use strict';
// Bounds on everything that waits on, or buffers, another party. One mutable
// object so tests can shorten a deadline (and restore it) without real waits.
const LIMITS = {
  // A git command (fetch, clone, merge, …): killed when it runs longer than this.
  GIT_TIMEOUT_MS: 15 * 60_000,
  // A git transfer that moves less than 1 byte/s for this long is aborted by git itself.
  GIT_STALL_SECONDS: 60,
  // The most of a git command's stdout, and of its stderr, kept in memory: the tail, where git reports errors.
  GIT_OUTPUT_MAX_CHARS: 1024 * 1024,
  // One HTTP call to a peer (register, status): the whole exchange, connect to last byte.
  PEER_HTTP_TIMEOUT_MS: 15_000,
  // The largest peer reply read into memory.
  PEER_RESPONSE_MAX_BYTES: 1024 * 1024,
  // The peer's leader flag, read during sync: shorter than PEER_HTTP_TIMEOUT_MS, since sync falls back to the
  // stored flag rather than wait on a slow peer.
  LEADER_FLAG_TIMEOUT_MS: 5000,
  // The largest request body either server reads into memory (web UI API, /control/register).
  REQUEST_BODY_MAX_BYTES: 1024 * 1024,
  // `cloudflared --version`, the check before a tunnel starts.
  CLOUDFLARED_CHECK_TIMEOUT_MS: 10_000,
};

module.exports = { LIMITS };
