import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Job, ToolCard } from "../../shared/api.js";
import type { SettingsSection } from "../../shared/settings.js";
import type { ArrClient } from "../integrations/arr.js";
import type { PlexClient, PlexMonitor } from "../integrations/plex.js";
import type { QbittorrentClient } from "../integrations/qbittorrent.js";
import type { Telegram } from "../integrations/telegram.js";
import type { Db, Migration } from "./db.js";
import type { EventBus } from "./events.js";
import type { HealthCheckDef } from "./health.js";
import type { EnqueueOptions, JobType } from "./jobs.js";
import type { Scheduler } from "./schedule.js";
import type { SettingsStore } from "./settings.js";
import type { SummarySection } from "./summary.js";

export interface Integrations {
  plex: PlexClient;
  sonarr: ArrClient;
  radarr: ArrClient;
  qbittorrent: QbittorrentClient;
  telegram: Telegram;
}

/** Everything the core offers a tool. */
export interface ToolContext {
  readonly toolId: string;
  /** A folder of the tool's own on Kondo's disk (created on start-up). */
  readonly dataDir: string;
  /** The running Kondo version. */
  readonly version: string;
  readonly db: Db;
  readonly settings: SettingsStore;
  readonly events: EventBus;
  readonly log: FastifyBaseLogger;
  readonly integrations: Integrations;
  readonly plex: PlexMonitor;
  readonly scheduler: Scheduler;
  defineJob<P, R>(type: string, def: JobType<P, R>): void;
  enqueue<P>(type: string, payload: P, options?: EnqueueOptions): Job;
  listJobs(limit?: number): Job[];
  /** How many of this tool's jobs of `type` are queued, running or paused. */
  activeJobs(type: string): number;
  addHealthCheck(def: HealthCheckDef): void;
  /** Routes are mounted under /api/tools/<toolId>. */
  routes(register: (app: FastifyInstance) => void | Promise<void>): void;
  /**
   * Runs `task` every `intervalMs()` (re-read each time, so it can follow a setting),
   * first after `firstAfterMs`. Started and stopped with Kondo.
   */
  every(intervalMs: () => number, task: () => void | Promise<void>, firstAfterMs?: number): void;
  /** The dashboard summary, built from the tool's own state. */
  setCard(card: () => ToolCard | Promise<ToolCard>): void;
  /** Lines for the morning Telegram summary: what the tool did since `since`. */
  addSummary(lines: SummarySection): void;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  /** Settings sections; each scope must be the tool id or start with "<id>.". */
  settings?: SettingsSection[];
  migrations?: Migration[];
  register(ctx: ToolContext): void | Promise<void>;
}

export function defineTool(def: ToolDefinition): ToolDefinition {
  return def;
}
