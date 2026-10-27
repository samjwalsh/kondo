// Types shared by the server and the web UI.

export interface HealthResponse {
  status: "ok";
  version: string;
  node: string;
  startedAt: string;
  uptimeSeconds: number;
}

export type HealthStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  message: string;
  checkedAt: string;
}

export interface HealthSummary {
  overall: HealthStatus;
  checks: HealthCheck[];
}

export type SlotId = "gpu" | "cpu" | "general";

export type JobState = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: number;
  tool: string;
  type: string;
  slot: SlotId;
  title: string;
  state: JobState;
  priority: number;
  /** Started by hand: runs outside the night window (still yields to Plex). */
  force: boolean;
  progress: number | null;
  progressText: string | null;
  result: unknown;
  error: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface JobLogLine {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface JobDetail extends Job {
  logs: JobLogLine[];
}

export interface SlotStatus {
  id: SlotId;
  label: string;
  concurrency: number;
  /** Whether queued jobs may start (and running ones continue) right now. */
  allowed: boolean;
  reason: string;
  jobs: Job[];
  queued: number;
}

export interface PlexSession {
  title: string;
  user: string | null;
  player: string | null;
  state: string;
  transcode: "none" | "gpu" | "cpu";
  file: string | null;
}

export interface PlexActivity {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  sessions: PlexSession[];
  /** When the last session ended (null while someone is watching or unknown). */
  quietSince: string | null;
  checkedAt: string | null;
}

export interface ScheduleInfo {
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  inWindow: boolean;
  idleMode: boolean;
  idleQuietMinutes: number;
  localTime: string;
  /** Sam paused all work by hand. */
  paused: boolean;
}

export interface ToolCard {
  status: HealthStatus;
  lines: string[];
}

export interface ToolSummary {
  id: string;
  name: string;
  description: string;
  card: ToolCard | null;
}

export interface StatusResponse {
  version: string;
  startedAt: string;
  health: HealthSummary;
  slots: SlotStatus[];
  plex: PlexActivity;
  schedule: ScheduleInfo;
  tools: ToolSummary[];
}

export type KondoEvent =
  | { type: "job.updated"; job: Job }
  | { type: "job.log"; jobId: number; line: JobLogLine }
  | { type: "status.changed"; reason: "plex" | "schedule" | "health" | "slots" }
  | { type: "settings.changed"; scope: string };
