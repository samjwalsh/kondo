import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Job, ToolCard } from "../../shared/api.js";
import type { SettingsSection } from "../../shared/settings.js";
import type { ArrClient } from "../integrations/arr.js";
import type { PlexClient, PlexMonitor } from "../integrations/plex.js";
import type { Telegram } from "../integrations/telegram.js";
import type { Db, Migration } from "./db.js";
import type { EventBus } from "./events.js";
import type { HealthCheckDef } from "./health.js";
import type { EnqueueOptions, JobType } from "./jobs.js";
import type { Scheduler } from "./schedule.js";
import type { SettingsStore } from "./settings.js";

export interface Integrations {
  plex: PlexClient;
  sonarr: ArrClient;
  radarr: ArrClient;
  telegram: Telegram;
}

/** Everything the core offers a tool. */
export interface ToolContext {
  readonly toolId: string;
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
  addHealthCheck(def: HealthCheckDef): void;
  /** Routes are mounted under /api/tools/<toolId>. */
  routes(register: (app: FastifyInstance) => void | Promise<void>): void;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  /** Settings sections; each scope must be the tool id or start with "<id>.". */
  settings?: SettingsSection[];
  migrations?: Migration[];
  register(ctx: ToolContext): void | Promise<void>;
  /** A small summary for the dashboard. */
  card?(): ToolCard | Promise<ToolCard>;
}

export function defineTool(def: ToolDefinition): ToolDefinition {
  return def;
}
