// Types shared by the IPs tool's server code and its web page.

export interface TakenIp {
  ip: string;
  /** Why it counts as taken. */
  by: "reply" | "arp" | "this machine" | "reserved";
  mac: string | null;
}

export interface IpScan {
  /** The network scanned, e.g. "10.0.0.0/24". */
  network: string;
  from: string;
  to: string;
  /** The lowest address in the range nobody answered on, or null if all are taken. */
  firstFree: string | null;
  freeCount: number;
  taken: TakenIp[];
  scannedAt: string;
  error: string | null;
}
