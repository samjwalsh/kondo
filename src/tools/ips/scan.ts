import os from "node:os";
import { runProcess } from "../../server/core/process.js";
import type { IpScan, TakenIp } from "./shared.js";

export interface Network {
  /** The first three octets, e.g. "10.0.0". */
  prefix: string;
  self: string;
}

/** The machine's own /24 on its first non-internal IPv4 interface. */
export function localNetwork(): Network | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      return { prefix: a.address.split(".").slice(0, 3).join("."), self: a.address };
    }
  }
  return null;
}

/**
 * Neighbours that answered ARP, from `ip -4 neigh` lines like
 * "10.0.0.5 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE".
 * FAILED/INCOMPLETE entries never answered; anything with a MAC did.
 */
export function parseNeighbours(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+) .*lladdr (\S+)(?: \w+)* (\w+)$/);
    if (!m) continue;
    const [, ip, mac, state] = m;
    if (ip && mac && state !== "FAILED" && state !== "INCOMPLETE") out.set(ip, mac);
  }
  return out;
}

export interface Probe {
  ping(ip: string): Promise<boolean>;
  neighbours(): Promise<string[]>;
}

export const systemProbe: Probe = {
  async ping(ip) {
    const result = await runProcess("ping", ["-n", "-c", "1", "-W", "1", ip], { timeoutMs: 5000 });
    return result.code === 0;
  },
  async neighbours() {
    const out: string[] = [];
    await runProcess("ip", ["-4", "neigh", "show"], { onStdoutLine: (l) => out.push(l.trim()) });
    return out;
  },
};

export interface ScanOptions {
  network: Network;
  from: number;
  to: number;
  /** Last octets or full addresses that count as taken even when silent. */
  reserved: string[];
  probe?: Probe;
  concurrency?: number;
}

/**
 * Pings every address in the range, then reads the ARP table: a device that drops
 * ping still had to answer ARP for the ping to be sent, so it shows up there.
 */
export async function scanRange(options: ScanOptions): Promise<IpScan> {
  const { network, probe = systemProbe, concurrency = 32 } = options;
  const from = Math.max(1, Math.min(options.from, options.to));
  const to = Math.min(254, Math.max(options.from, options.to));
  const ips: string[] = [];
  for (let n = from; n <= to; n++) ips.push(`${network.prefix}.${n}`);

  const replied = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < ips.length) {
      const ip = ips[next++] as string;
      if (ip !== network.self && (await probe.ping(ip))) replied.add(ip);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  const arp = parseNeighbours(await probe.neighbours());

  const reserved = new Set(
    options.reserved.map((r) => (/^\d+$/.test(r) ? `${network.prefix}.${r}` : r)),
  );
  const taken: TakenIp[] = [];
  for (const ip of ips) {
    const mac = arp.get(ip) ?? null;
    if (ip === network.self) taken.push({ ip, by: "this machine", mac: null });
    else if (replied.has(ip)) taken.push({ ip, by: "reply", mac });
    else if (mac) taken.push({ ip, by: "arp", mac });
    else if (reserved.has(ip)) taken.push({ ip, by: "reserved", mac: null });
  }
  const takenSet = new Set(taken.map((t) => t.ip));
  const free = ips.filter((ip) => !takenSet.has(ip));
  return {
    network: `${network.prefix}.0/24`,
    from: ips[0] ?? "",
    to: ips.at(-1) ?? "",
    firstFree: free[0] ?? null,
    freeCount: free.length,
    taken,
    scannedAt: new Date().toISOString(),
    error: null,
  };
}
