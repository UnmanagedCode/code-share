'use strict';
const os = require('os');
const { execSync } = require('child_process');

// Preference order: most-specific private ranges first; 10.x last (overlaps VPN ranges).
const LAN_PRIORITIES = [
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^10\./,
];

function pickBestLanIP(candidates) {
  for (const re of LAN_PRIORITIES) {
    const hit = candidates.find(a => re.test(a));
    if (hit) return hit;
  }
  return candidates.find(a => !/^127\./.test(a)) || '127.0.0.1';
}

function getLanIP() {
  const candidates = [];

  // Source 1: os.networkInterfaces() — reliable on Linux/Mac/Windows.
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const iface of addrs) {
      if (iface.family === 'IPv4' && !iface.internal && !/^127\./.test(iface.address)) {
        candidates.push(iface.address);
      }
    }
  }

  // Short-circuit: if we already have a private LAN IP, no need to shell out.
  if (LAN_PRIORITIES.some(re => candidates.some(a => re.test(a)))) {
    return pickBestLanIP(candidates);
  }

  // Source 2: ifconfig fallback — needed on Android/Termux, where process isolation
  // causes os.networkInterfaces() to return only the loopback interface even though
  // wlan0/eth0 are present and routable.
  try {
    const out = execSync('ifconfig 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    const re = /inet (\d+\.\d+\.\d+\.\d+)\s+netmask (\S+)/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      const [, addr, mask] = m;
      // Skip loopback and point-to-point VPN addresses (netmask /32 = 255.255.255.255).
      if (!/^127\./.test(addr) && mask !== '255.255.255.255') {
        candidates.push(addr);
      }
    }
  } catch {
    // ifconfig unavailable — accept whatever os.networkInterfaces() gave us.
  }

  return pickBestLanIP(candidates);
}

function startMdns(port, name) {
  try {
    const { Bonjour } = require('bonjour-service');
    const bonjour = new Bonjour();
    bonjour.publish({ name: name || 'code-share', type: 'http', port });
    console.log(`mDNS: advertised "${name || 'code-share'}" on port ${port}`);
    return () => bonjour.destroy();
  } catch (e) {
    console.warn('mDNS unavailable:', e.message);
    return () => {};
  }
}

module.exports = { getLanIP, startMdns };
