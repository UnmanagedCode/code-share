'use strict';
const os = require('os');

function getLanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
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
