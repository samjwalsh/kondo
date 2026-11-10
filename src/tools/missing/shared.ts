// Types shared by the missing tool's server code and its web page.

export interface MissingRun {
  id: number;
  at: string;
  app: "sonarr" | "radarr";
  /** Monitored items with no file, not counting ones already downloading. */
  missing: number;
  /** What this run asked Sonarr/Radarr to search for, e.g. "NCIS S24E04". */
  searched: string[];
  error: string | null;
}

export interface MissingStatus {
  enabled: boolean;
  everyHours: number;
  perRun: number;
  lastRunAt: string | null;
  /** When the next run is due (null while switched off). */
  nextRunAt: string | null;
}
