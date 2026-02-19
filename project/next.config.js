const os = require('os');

function lanDevOrigins() {
  const hosts = new Set(["localhost", "127.0.0.1"]);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const family = String(addr.family);
      if ((family === "IPv4" || family === "4") && !addr.internal) {
        hosts.add(addr.address);
      }
    }
  }
  return Array.from(hosts);
}

const nextConfig = {
  allowedDevOrigins: lanDevOrigins(),
};

module.exports = nextConfig;