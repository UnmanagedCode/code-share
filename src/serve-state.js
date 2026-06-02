'use strict';
const net = require('net');

// Returns true if the git server is accepting TCP connections on 127.0.0.1:<port>.
// A 500 ms timeout is enough to distinguish "port open" from "nothing listening".
function isServing(port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error',   () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

// Returns true when the URL host is a public internet address.
// Treated as LAN/private: RFC1918 (10/8, 172.16/12, 192.168/16),
// loopback (127/8, localhost), and *.local mDNS names.
function isInternetUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname;
    if (host === 'localhost' || host.endsWith('.local')) return false;
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { isServing, isInternetUrl };
