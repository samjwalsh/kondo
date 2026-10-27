// Types shared by the downloads tool's server code and its web page.

export type DownloadsMode = "off" | "report" | "remove";

/** found: seen in report-only mode; removed: blocklisted and deleted; error: removal failed. */
export type FakeAction = "found" | "removed" | "error";

export interface FakeEntry {
  id: number;
  at: string;
  hash: string;
  /** The torrent's name in qBittorrent. */
  name: string;
  app: "sonarr" | "radarr" | null;
  /** e.g. "NCIS S24E04", from Sonarr/Radarr's record of the grab. */
  what: string | null;
  indexer: string | null;
  /** The files that gave it away, e.g. "NCIS S24E04.exe". */
  badFiles: string[];
  action: FakeAction;
  detail: string | null;
}

export interface CheckInfo {
  at: string;
  torrents: number;
  fakes: number;
  error: string | null;
}

export interface DownloadsStatus {
  mode: DownloadsMode;
  configured: boolean;
  lastCheck: CheckInfo | null;
  /** Fakes found in report-only mode that are still in qBittorrent. */
  waiting: number;
  removed: number;
}
