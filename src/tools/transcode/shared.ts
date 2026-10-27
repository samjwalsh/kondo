// Types shared by the transcode tool's server code and its web page.

export type Decision = "transcode" | "skip" | "error";

export type ReasonCode =
  | "h264"
  | "old-codec"
  | "h265-high-bitrate"
  | "already-efficient"
  | "kondo-done"
  | "squish-done"
  | "hdr"
  | "above-1080p"
  | "no-video"
  | "unknown-codec"
  | "small-saving"
  | "probe-failed"
  | "not-worth-it"
  | "rejected"
  | "encode-failed";

export const REASON_LABELS: Record<ReasonCode, string> = {
  h264: "H.264 → H.265",
  "old-codec": "Older codec → H.265",
  "h265-high-bitrate": "H.265 above the bitrate threshold",
  "already-efficient": "Already H.265/AV1 at a good size",
  "kondo-done": "Already done by Kondo",
  "squish-done": "Already done by Squish",
  hdr: "HDR or Dolby Vision (not handled yet)",
  "above-1080p": "Above 1080p (not handled yet)",
  "no-video": "No video stream",
  "unknown-codec": "Video codec Kondo doesn't know",
  "small-saving": "Saving too small to be worth it",
  "probe-failed": "Couldn't read the file",
  "not-worth-it": "Tried, but the result wasn't small enough",
  rejected: "You rejected or cancelled it",
  "encode-failed": "Encoding failed twice",
};

export type Hdr = "none" | "hdr10" | "hlg" | "dolby-vision";

export interface VideoInfo {
  index: number;
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  bitDepth: number;
  hdr: Hdr;
  kbps: number | null;
  /** True when the bitrate was worked out from the file size rather than read. */
  kbpsEstimated: boolean;
}

export interface AudioInfo {
  index: number;
  codec: string;
  profile: string | null;
  channels: number;
  language: string | null;
  /** The language came from the title because the track wasn't tagged. */
  languageFromTitle: boolean;
  title: string | null;
  isDefault: boolean;
  commentary: boolean;
  descriptive: boolean;
  kbps: number | null;
}

export interface SubtitleInfo {
  index: number;
  codec: string;
  language: string | null;
  languageFromTitle: boolean;
  title: string | null;
  isDefault: boolean;
  forced: boolean;
  hearingImpaired: boolean;
  kbps: number | null;
}

export interface AttachmentInfo {
  index: number;
  mimetype: string | null;
  filename: string | null;
  font: boolean;
}

export interface MediaInfo {
  container: string;
  durationS: number;
  sizeBytes: number;
  video: VideoInfo | null;
  audio: AudioInfo[];
  subtitles: SubtitleInfo[];
  attachments: AttachmentInfo[];
  /** Kondo's own marker inside files it has produced. */
  kondoTag: string | null;
}

export interface PlannedTrack {
  index: number;
  kind: "audio" | "subtitle" | "attachment";
  /** e.g. "English · DTS-HD MA 5.1 · “Commentary”" */
  summary: string;
  action: "keep" | "convert" | "drop";
  /** For conversions, e.g. "E-AC3 5.1 · 640 kb/s". */
  to?: string;
  reason: string;
  /** Becomes the default track of its kind in the new file. */
  makeDefault?: boolean;
  /** Language to write into the new file for a track that wasn't tagged. */
  setLanguage?: string;
}

export interface Plan {
  video: { from: string; to: string };
  tracks: PlannedTrack[];
  notes: string[];
  estimatedBytes: number;
}

export interface ArrMatch {
  app: "sonarr" | "radarr";
  id: number;
  title: string;
  originalLanguage: string | null;
}

export interface FileSummary {
  id: number;
  /** Path relative to its library folder. */
  path: string;
  root: string;
  sizeBytes: number;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  videoKbps: number | null;
  decision: Decision | null;
  reasonCode: ReasonCode | null;
  reason: string | null;
  estimatedBytes: number | null;
  outcomeStatus: OutcomeStatus | null;
}

export type OutcomeStatus =
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "not-worth-it"
  | "failed"
  | "swapping"
  | "done"
  | "squish";

export const OUTCOME_LABELS: Record<OutcomeStatus, string> = {
  "awaiting-approval": "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  "not-worth-it": "Not worth it",
  failed: "Failed",
  swapping: "Swapping in",
  done: "Done",
  squish: "Done by Squish",
};

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  sourceSeconds: number;
  outputSeconds: number;
  audio: { expected: number; found: number };
  subtitles: { expected: number; found: number };
  videoCodec: string | null;
  decodeErrors: string[];
}

export interface EncodeDetails {
  encoder: string;
  encodeSeconds: number;
  averageFps: number | null;
  crop: string | null;
  sourceBytes: number;
  outputBytes: number;
  savingPercent: number;
  verify: VerifyReport;
  /** Timestamps (s) of the comparison frames saved as frame-source-N.jpg / frame-output-N.jpg. */
  frames: number[];
}

export interface Outcome {
  fileId: number;
  status: OutcomeStatus;
  encoder: string | null;
  outputBytes: number | null;
  details: EncodeDetails | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

/** A file swapped into the library. */
export interface HistoryItem {
  fileId: number;
  /** Full path of the new file. */
  path: string;
  sourceBytes: number;
  outputBytes: number;
  encoder: string | null;
  swappedAt: string;
  details: EncodeDetails | null;
}

export interface ApprovalItem {
  file: FileSummary;
  outcome: Outcome;
  plan: Plan | null;
}

export interface FileDetail extends FileSummary {
  info: MediaInfo | null;
  plan: Plan | null;
  arr: ArrMatch | null;
  probeError: string | null;
  probedAt: string | null;
  outcome: Outcome | null;
  /** An encode job for this file is queued or running. */
  encoding: boolean;
}

export interface ScanInfo {
  startedAt: string;
  finishedAt: string | null;
  files: number;
  probed: number;
  errors: number;
  error: string | null;
}

export interface LibrarySummary {
  roots: string[];
  files: number;
  bytes: number;
  toTranscode: { count: number; bytes: number; estimatedBytes: number };
  skipped: { count: number; bytes: number };
  problems: number;
  notYetRead: number;
  awaitingApproval: number;
  /** Results swapped into the library so far. */
  done: { count: number; savedBytes: number };
  byReason: { code: ReasonCode; label: string; count: number; bytes: number }[];
  lastScan: ScanInfo | null;
}

export interface FilesPage {
  total: number;
  files: FileSummary[];
}

export type SquishStatus = "pending" | "clash" | "done" | "gone" | "error";

/** One series or movie folder with files still named `… [SQUISH].…`. */
export interface SquishTitle {
  /** Full path of the series/movie folder. */
  key: string;
  name: string;
  pending: number;
  clashes: number;
  done: number;
}

export interface SquishItem {
  /** Path relative to the title's folder. */
  path: string;
  /** The new file name. */
  target: string;
  status: SquishStatus;
  error: string | null;
}

export interface SquishSummary {
  checkedAt: string | null;
  titles: SquishTitle[];
  pending: number;
  clashes: number;
  done: number;
}

export type FileFilter = "transcode" | "skip" | "error" | "all";
export type FileSort = "saving" | "size" | "path";

/** One clip encoded both ways, compared against the original. */
export interface CalibrationSample {
  fileId: number;
  name: string;
  /** e.g. "1080p, 8.2 Mb/s" */
  label: string;
  clipStartS: number;
  clipSeconds: number;
  gpu: CalibrationPoint;
  cpu: (CalibrationPoint & { crf: number })[];
}

export interface CalibrationPoint {
  /** SSIM against the original, in dB (higher is closer). */
  ssimDb: number;
  /** Video bitrate of the result. */
  kbps: number;
  /** Encoding speed as a multiple of real time. */
  speed: number;
}

export interface Calibration {
  finishedAt: string;
  preset: string;
  crfs: number[];
  samples: CalibrationSample[];
  /** Average SSIM of the GPU's results. */
  gpuSsimDb: number;
  /** The highest CRF whose average SSIM still matches the GPU's, or null if none tested did. */
  recommendedCrf: number | null;
  /** How the CPU's files compare in size at that CRF, e.g. -28 for 28% smaller. */
  sizeVsGpuPercent: number | null;
  /** Average CPU speed at the recommended CRF. */
  cpuSpeed: number | null;
  note: string | null;
}
