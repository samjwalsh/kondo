// Types shared by the IPs tool's server code and its web page.

/**
 * free: nothing answers and no container is set to it.
 * stopped: nothing answers, but a stopped container is set to it.
 * taken: something answers, a running container has it, or it's listed in Settings.
 */
export type IpState = "free" | "stopped" | "taken";

export interface IpAddress {
  ip: string;
  last: number;
  state: IpState;
  /** What uses it: container name(s), DNS name, "Kondo", … */
  label: string | null;
  /** How Kondo knows, e.g. "answered ping", "container, stopped". */
  why: string;
  mac: string | null;
  /** Something answers here although a container that isn't running is set to it. */
  clash: boolean;
}

export interface IpScan {
  /** The network scanned, e.g. "10.0.0.0/24". */
  network: string;
  from: string;
  to: string;
  addresses: IpAddress[];
  /** The lowest free address, or null if none is. */
  firstFree: string | null;
  freeCount: number;
  /** Whether container addresses came from Unraid. */
  docker: { used: boolean; error: string | null; containers: number };
  scannedAt: string;
  error: string | null;
}
