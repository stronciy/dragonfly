import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
  if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function isNetworkOrBroadcastAddress(addr: string, netmask: string): boolean {
  const a = ipToInt(addr);
  const m = ipToInt(netmask);
  if (a === null || m === null) return false;
  if ((a & m) === a) return true;
  if (((a | m) >>> 0) === 0xffffffff) return true;
  return false;
}

function getLocalIPv4Addresses(): string[] {
  const ips = new Set<string>();
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      if (net.netmask && isNetworkOrBroadcastAddress(net.address, net.netmask)) continue;
      ips.add(net.address);
    }
  }
  return Array.from(ips);
}

const DEV_PORTS = [3000, 3001, 8081, 19006];
const STATIC_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:19006",
  "http://127.0.0.1:19006",
];

const localIPs = getLocalIPv4Addresses();
const dynamicOrigins = localIPs.flatMap((ip) => DEV_PORTS.map((port) => `http://${ip}:${port}`));

if (process.env.NODE_ENV !== "production" && localIPs.length > 0) {
  console.info(`[next.config] Detected LAN IPs: ${localIPs.join(", ")}`);
  console.info(`[next.config] allowedDevOrigins: ${[...STATIC_ORIGINS, ...dynamicOrigins].join(", ")}`);
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  allowedDevOrigins: [...STATIC_ORIGINS, ...dynamicOrigins],
};

export default nextConfig;
