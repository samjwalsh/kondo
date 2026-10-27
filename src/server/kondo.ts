import { existsSync, mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { ToolCard } from "../shared/api.js";
import type { SettingsSection } from "../shared/settings.js";
import { tools as builtInTools } from "../tools/server.js";
import type { Config } from "./config.js";
import { coreMigrations, type Db, migrate, openDb } from "./core/db.js";
import { EventBus } from "./core/events.js";
import { Health } from "./core/health.js";
import { JobQueue, type SlotConfig } from "./core/jobs.js";
import { Alerts, Heartbeat } from "./core/notify.js";
import { encodingSettings, Scheduler, scheduleSettings } from "./core/schedule.js";
import { SettingsStore } from "./core/settings.js";
import type { Integrations, ToolContext, ToolDefinition } from "./core/tools.js";
import { ArrClient, arrSettings } from "./integrations/arr.js";
import { errorMessage } from "./integrations/http.js";
import { Kuma, kumaSettings } from "./integrations/kuma.js";
import { PlexClient, PlexMonitor, plexSettings } from "./integrations/plex.js";
import { Telegram, telegramSettings } from "./integrations/telegram.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerHealthRoutes } from "./routes/health.js";

const SLOTS: SlotConfig[] = [
  { id: "gpu", label: "GPU", concurrency: 1 },
  { id: "cpu", label: "CPU", concurrency: 1 },
  { id: "general", label: "General", concurrency: 2 },
];

const STUCK_AFTER_MS = 30 * 60_000;

export interface KondoOptions {
  /** Run timers, polling and the job loop (off in tests). */
  background?: boolean;
  tools?: ToolDefinition[];
}

export interface Kondo {
  app: FastifyInstance;
  db: Db;
  events: EventBus;
  settings: SettingsStore;
  jobs: JobQueue;
  health: Health;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createKondo(config: Config, options: KondoOptions = {}): Promise<Kondo> {
  const background = options.background ?? true;
  const tools = options.tools ?? builtInTools;
  const startedAt = new Date();

  const app = Fastify({
    logger: { level: config.logLevel },
    // The UI polls health every 10 s; logging those would flood the journal.
    // (Turning request logging off entirely would also hide request errors.)
    logController: new LogController({
      disableRequestLogging: (request) => request.url === "/api/health",
    }),
    // Live-update streams never go idle; close them on shutdown.
    forceCloseConnections: true,
  });

  const db = openDb(config.dataDir);
  migrate(db, "core", coreMigrations);
  const events = new EventBus();
  const settings = new SettingsStore(db, events);
  for (const section of [
    scheduleSettings,
    encodingSettings,
    plexSettings,
    arrSettings("sonarr"),
    arrSettings("radarr"),
    telegramSettings,
    kumaSettings,
  ]) {
    settings.register(section);
  }

  const integrations: Integrations = {
    plex: new PlexClient(settings),
    sonarr: new ArrClient("sonarr", settings),
    radarr: new ArrClient("radarr", settings),
    telegram: new Telegram(settings),
  };
  const kuma = new Kuma(settings);
  const plex = new PlexMonitor(integrations.plex, events, app.log);
  const scheduler = new Scheduler(settings, plex, events);
  const jobs = new JobQueue(db, events, app.log, SLOTS);
  jobs.setPolicy((slot, force) => scheduler.decide(slot, force));
  scheduler.setQueuedCounter(() => jobs.queuedCount(["gpu", "cpu"]));

  const health = new Health(events, app.log);
  const heartbeat = new Heartbeat(kuma, () => health.summary(), app.log);
  registerCoreChecks({
    health,
    plex,
    integrations,
    kuma,
    heartbeat,
    jobs,
    scheduler,
    dataDir: config.dataDir,
  });
  const alerts = new Alerts(integrations.telegram, app.log);
  health.onEvaluated((summary) => alerts.onHealth(summary));

  const repeating = new RepeatingTasks(app.log);
  const cards = new Map<string, () => ToolCard | Promise<ToolCard>>();
  for (const tool of tools) {
    await registerTool(tool, {
      app,
      dataDir: config.dataDir,
      version: config.version,
      db,
      settings,
      events,
      integrations,
      plex,
      scheduler,
      jobs,
      health,
      repeating,
      cards,
    });
  }

  registerHealthRoutes(app, config);
  registerApiRoutes(app, {
    version: config.version,
    startedAt,
    events,
    settings,
    jobs,
    health,
    plex,
    scheduler,
    tools,
    cards,
    testers: {
      plex: () => integrations.plex.test(),
      sonarr: () => integrations.sonarr.test(),
      radarr: () => integrations.radarr.test(),
      telegram: () => integrations.telegram.test(),
      kuma: () => kuma.test(),
    },
  });
  await registerWebUi(app, config.webDir);

  return {
    app,
    db,
    events,
    settings,
    jobs,
    health,
    async start() {
      await jobs.recover();
      if (!background) return;
      plex.start();
      scheduler.start();
      jobs.start();
      health.start();
      heartbeat.start();
      repeating.start();
    },
    async stop() {
      repeating.stop();
      heartbeat.stop();
      health.stop();
      await jobs.stop();
      scheduler.stop();
      plex.stop();
      await app.close();
      db.close();
    },
  };
}

interface ToolDeps {
  app: FastifyInstance;
  dataDir: string;
  version: string;
  db: Db;
  settings: SettingsStore;
  events: EventBus;
  integrations: Integrations;
  plex: PlexMonitor;
  scheduler: Scheduler;
  jobs: JobQueue;
  health: Health;
  repeating: RepeatingTasks;
  cards: Map<string, () => ToolCard | Promise<ToolCard>>;
}

/** Timers tools ask for with ctx.every(); only run while Kondo runs in the background. */
class RepeatingTasks {
  private readonly tasks: {
    intervalMs: () => number;
    task: () => void | Promise<void>;
    firstAfterMs: number;
  }[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private running = false;

  constructor(private readonly log: FastifyInstance["log"]) {}

  add(intervalMs: () => number, task: () => void | Promise<void>, firstAfterMs = 10_000): void {
    this.tasks.push({ intervalMs, task, firstAfterMs });
  }

  start(): void {
    this.running = true;
    for (const t of this.tasks) {
      const run = async () => {
        try {
          await t.task();
        } catch (error) {
          this.log.error({ err: error }, "repeating task failed");
        }
        if (this.running) this.schedule(run, t.intervalMs());
      };
      this.schedule(run, t.firstAfterMs);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(run: () => Promise<void>, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void run();
    }, delayMs);
    this.timers.add(timer);
  }
}

async function registerTool(tool: ToolDefinition, deps: ToolDeps): Promise<void> {
  mkdirSync(path.join(deps.dataDir, "tools", tool.id), { recursive: true });
  for (const section of tool.settings ?? []) {
    assertToolScope(tool, section);
    deps.settings.register(section);
  }
  migrate(deps.db, `tool:${tool.id}`, tool.migrations ?? []);
  const routes: ((app: FastifyInstance) => void | Promise<void>)[] = [];
  const ctx: ToolContext = {
    toolId: tool.id,
    dataDir: path.join(deps.dataDir, "tools", tool.id),
    version: deps.version,
    db: deps.db,
    settings: deps.settings,
    events: deps.events,
    log: deps.app.log.child({ tool: tool.id }),
    integrations: deps.integrations,
    plex: deps.plex,
    scheduler: deps.scheduler,
    defineJob: (type, def) => deps.jobs.define(tool.id, type, def),
    enqueue: (type, payload, options) => deps.jobs.enqueue(tool.id, type, payload, options),
    listJobs: (limit) => deps.jobs.list({ tool: tool.id, limit }),
    activeJobs: (type) => deps.jobs.activeCount(tool.id, type),
    addHealthCheck: (def) => deps.health.register({ ...def, id: `${tool.id}.${def.id}` }),
    routes: (register) => routes.push(register),
    every: (intervalMs, task, firstAfterMs) => deps.repeating.add(intervalMs, task, firstAfterMs),
    setCard: (card) => deps.cards.set(tool.id, card),
  };
  await tool.register(ctx);
  if (routes.length > 0) {
    await deps.app.register(
      async (scoped) => {
        for (const register of routes) await register(scoped);
      },
      { prefix: `/api/tools/${tool.id}` },
    );
  }
}

function assertToolScope(tool: ToolDefinition, section: SettingsSection): void {
  if (section.scope !== tool.id && !section.scope.startsWith(`${tool.id}.`)) {
    throw new Error(
      `Tool ${tool.id} may only declare settings scopes named "${tool.id}" or "${tool.id}.*"`,
    );
  }
}

interface CoreCheckDeps {
  health: Health;
  plex: PlexMonitor;
  integrations: Integrations;
  kuma: Kuma;
  heartbeat: Heartbeat;
  jobs: JobQueue;
  scheduler: Scheduler;
  dataDir: string;
}

function registerCoreChecks(d: CoreCheckDeps): void {
  d.health.register({
    id: "plex",
    label: "Plex",
    check: () => {
      const a = d.plex.activity();
      if (!a.configured) {
        return {
          status: "warn",
          message: "Not set up yet. Encoding waits until Kondo can see who's watching.",
        };
      }
      if (!a.reachable) return { status: "error", message: `Can't reach Plex: ${a.error}` };
      const n = a.sessions.length;
      return {
        status: "ok",
        message: n === 0 ? "Connected; nobody watching" : `Connected; ${n} watching`,
      };
    },
  });

  for (const arr of [d.integrations.sonarr, d.integrations.radarr]) {
    d.health.register({
      id: arr.app,
      label: arr.name,
      check: async () => {
        if (!arr.configured()) return { status: "warn", message: "Not set up yet" };
        try {
          return { status: "ok", message: `Connected (${await arr.version()})` };
        } catch (error) {
          return { status: "error", message: `Can't reach ${arr.name}: ${errorMessage(error)}` };
        }
      },
    });
  }

  d.health.register({
    id: "telegram",
    label: "Telegram alerts",
    check: () =>
      d.integrations.telegram.configured()
        ? { status: "ok", message: "Ready" }
        : { status: "warn", message: "Not set up, so Kondo can't tell you about problems" },
  });

  d.health.register({
    id: "heartbeat",
    label: "Uptime Kuma heartbeat",
    check: () => {
      if (!d.kuma.configured()) {
        return { status: "warn", message: "Not set up, so nothing will notice if Kondo stops" };
      }
      const last = d.heartbeat.lastResult();
      if (!last) return { status: "ok", message: "Waiting for the first check-in" };
      return last.ok
        ? { status: "ok", message: last.message }
        : { status: "warn", message: `Last check-in failed: ${last.message}` };
    },
  });

  d.health.register({
    id: "jobs",
    label: "Jobs",
    check: () => {
      const stuck = d.jobs.stuck(STUCK_AFTER_MS);
      if (stuck.length === 0) return { status: "ok", message: "Nothing stuck" };
      return {
        status: "error",
        message: `No progress for 30+ minutes: ${stuck.map((j) => `#${j.id} ${j.title}`).join(", ")}`,
      };
    },
  });

  d.health.register({
    id: "window",
    label: "Night window",
    check: () => {
      const missed = d.scheduler.missedWindow();
      if (!missed) return { status: "ok", message: "OK" };
      return {
        status: "error",
        message: `The last night window ended with ${missed.queued} job(s) waiting and nothing done`,
      };
    },
  });

  d.health.register({
    id: "disk",
    label: "Kondo's disk",
    check: async () => {
      const s = await statfs(d.dataDir);
      const freePct = (Number(s.bavail) / Number(s.blocks)) * 100;
      const status = freePct < 3 ? "error" : freePct < 10 ? "warn" : "ok";
      return { status, message: `${freePct.toFixed(0)}% free` };
    },
  });
}

async function registerWebUi(app: FastifyInstance, webDir: string): Promise<void> {
  // The built UI doesn't exist in tests or under `dev:server`.
  const hasWeb = existsSync(`${webDir}/index.html`);
  if (hasWeb) await app.register(fastifyStatic, { root: webDir });

  app.setNotFoundHandler((request, reply) => {
    // Unknown API routes are real 404s; any other path is a page of the single-page app.
    if (request.url.startsWith("/api/") || !hasWeb) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
}
