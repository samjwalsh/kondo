import { Resolver } from "node:dns/promises";
import os from "node:os";
import { runProcess } from "../../server/core/process.js";
import type { UnraidContainer } from "../../server/integrations/unraid.js";
import type { IpAddress, IpScan } from "./shared.js";

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
  /** A DNS name for the address, if the local DNS knows one. */
  name(ip: string): Promise<string | null>;
}

const resolver = new Resolver({ timeout: 1000, tries: 1 });

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
  async name(ip) {
    try {
      const [name] = await resolver.reverse(ip);
      return name ? name.replace(/\.(lan|local|home|localdomain)$/i, "") : null;
    } catch {
      return null;
    }
  },
};

export interface ScanOptions {
  network: Network;
  from: number;
  to: number;
  /** Last octets or full addresses that count as taken even when silent. */
  reserved: string[];
  /** Containers from Unraid, or null when not set up. */
  containers: UnraidContainer[] | null;
  /** Known names for addresses, e.g. the Unraid server's own. */
  known?: Map<string, string>;
  dockerError?: string | null;
  probe?: Probe;
  concurrency?: number;
}

async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Pings every address in the range, then reads the ARP table: a device that drops
 * ping still had to answer ARP for the ping to be sent, so it shows up there.
 * Container addresses from Unraid add names, and stopped containers' addresses.
 */
export async function scanRange(options: ScanOptions): Promise<IpScan> {
  const { network, probe = systemProbe, concurrency = 32, containers } = options;
  const from = Math.max(1, Math.min(options.from, options.to));
  const to = Math.min(254, Math.max(options.from, options.to));
  const ips: string[] = [];
  for (let n = from; n <= to; n++) ips.push(`${network.prefix}.${n}`);

  const replied = new Set<string>();
  await eachLimited(ips, concurrency, async (ip) => {
    if (ip !== network.self && (await probe.ping(ip))) replied.add(ip);
  });
  const arp = parseNeighbours(await probe.neighbours());

  const reserved = new Set(
    options.reserved.map((r) => (/^\d+$/.test(r) ? `${network.prefix}.${r}` : r)),
  );
  const byIp = new Map<string, UnraidContainer[]>();
  for (const c of containers ?? []) {
    for (const ip of c.ips) byIp.set(ip, [...(byIp.get(ip) ?? []), c]);
  }

  const addresses: IpAddress[] = ips.map((ip) => {
    const mac = arp.get(ip) ?? null;
    const bound = byIp.get(ip) ?? [];
    const running = bound.filter((c) => c.running);
    const stopped = bound.filter((c) => !c.running);
    const answered = ip === network.self || replied.has(ip) || mac !== null;
    const names = (list: UnraidContainer[]) => list.map((c) => c.name).join(", ") || null;
    const base = { ip, last: Number(ip.split(".")[3]), mac, clash: false };

    if (ip === network.self)
      return { ...base, state: "taken", label: "Kondo", why: "this machine" };
    if (running.length > 0) {
      // Starting a stopped container set to the same address would clash with this one.
      return stopped.length > 0
        ? {
            ...base,
            state: "taken",
            label: names(running),
            why: `container, running; stopped ${names(stopped)} is also set to it`,
            clash: true,
          }
        : { ...base, state: "taken", label: names(running), why: "container, running" };
    }
    if (answered) {
      return {
        ...base,
        state: "taken",
        label: null,
        why: replied.has(ip) ? "answered ping" : "answered ARP only",
        // A device answers on an address a stopped container wants: starting it would clash.
        clash: stopped.length > 0,
        ...(stopped.length > 0 && { why: `answers, but stopped ${names(stopped)} is set to it` }),
      };
    }
    if (stopped.length > 0)
      return { ...base, state: "stopped", label: names(stopped), why: "container, stopped" };
    if (reserved.has(ip))
      return { ...base, state: "taken", label: null, why: "listed in Settings" };
    return { ...base, state: "free", label: null, why: "nothing answered" };
  });

  // Names for taken addresses no container explains (desktop, VMs, the router…).
  await eachLimited(
    addresses.filter((a) => a.state === "taken" && a.label === null),
    concurrency,
    async (a) => {
      a.label = options.known?.get(a.ip) ?? (await probe.name(a.ip));
    },
  );

  const free = addresses.filter((a) => a.state === "free");
  return {
    network: `${network.prefix}.0/24`,
    from: ips[0] ?? "",
    to: ips.at(-1) ?? "",
    addresses,
    firstFree: free[0]?.ip ?? null,
    freeCount: free.length,
    docker: {
      used: containers !== null,
      error: options.dockerError ?? null,
      containers: containers?.length ?? 0,
    },
    scannedAt: new Date().toISOString(),
    error: null,
  };
}
