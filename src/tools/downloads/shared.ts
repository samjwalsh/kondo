// Types shared by the downloads tool's server code and its web page.

export type DownloadsMode = "off" | "report" | "remove";

/** fake: carries a program instead of the video; stuck: stopped getting anywhere. */
export type ProblemKind = "fake" | "stuck";

/** found: seen in report-only mode; removed: blocklisted and deleted; error: removal failed. */
export type FakeAction = "found" | "removed" | "error";

export interface FakeEntry {
  id: number;
  at: string;
  hash: string;
  /** The torrent's name in qBittorrent. */
  name: string;
  kind: ProblemKind;
  app: "sonarr" | "radarr" | null;
  /** e.g. "NCIS S24E04", from Sonarr/Radarr's record of the grab. */
  what: string | null;
  indexer: string | null;
  /** The files that gave a fake away, e.g. "NCIS S24E04.exe" (empty for stuck downloads). */
  badFiles: string[];
  /** Why a stuck download counts as stuck, e.g. "No file list after 4 days". */
  problem: string | null;
  action: FakeAction;
  detail: string | null;
}

export interface CheckInfo {
  at: string;
  torrents: number;
  /** Fakes and stuck downloads found by the check and still in qBittorrent afterwards. */
  fakes: number;
  stuck?: number;
  error: string | null;
}

export interface DownloadsStatus {
  mode: DownloadsMode;
  stuckMode: DownloadsMode;
  configured: boolean;
  lastCheck: CheckInfo | null;
  /** Fakes and stuck downloads still in qBittorrent after the last check. */
  waiting: { fakes: number; stuck: number };
  removed: number;
}
