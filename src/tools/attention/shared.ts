// Types shared by the "Needs a look" tool's server code and its web page.

/**
 * - `not-found`: monitored, aired/available, no file, not downloading.
 * - `replace`: has a file Sonarr/Radarr would replace (below its custom format cutoff, e.g. a dub).
 * - `stalled`: a download that isn't getting anywhere (no peers, no file list), including
 *   private-tracker ones Kondo's Downloads tool leaves alone.
 * - `import`: a download Sonarr/Radarr can't import on their own.
 * - `health`: one of Sonarr/Radarr's own health warnings.
 * - `service`: Bazarr or Seerr not answering.
 */
export type AttentionKind = "not-found" | "replace" | "stalled" | "import" | "health" | "service";

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  /** Where it came from, e.g. "sonarr" or "bazarr". */
  app: string;
  /** Series or movie (for grouping), or the app. */
  group: string;
  what: string;
  detail: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface AttentionStatus {
  checkedAt: string | null;
  /** Problems that have lasted long enough to report. */
  due: AttentionItem[];
  /** Problems seen but not old enough yet (most sort themselves out). */
  watching: number;
  /** Sources the last check couldn't read. */
  errors: string[];
  stuckDays: number;
  stuckHours: number;
}
