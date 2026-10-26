import type { FastifyInstance } from "fastify";
import type { StatusResponse, ToolCard, ToolSummary } from "../../shared/api.js";
import type { SettingsResponse, SettingsUpdate, TestResult } from "../../shared/settings.js";
import type { EventBus } from "../core/events.js";
import type { Health } from "../core/health.js";
import type { JobQueue } from "../core/jobs.js";
import type { Scheduler } from "../core/schedule.js";
import { type SettingsStore, SettingsValidationError } from "../core/settings.js";
import type { ToolDefinition } from "../core/tools.js";
import type { PlexMonitor } from "../integrations/plex.js";

export interface ApiDeps {
  version: string;
  startedAt: Date;
  events: EventBus;
  settings: SettingsStore;
  jobs: JobQueue;
  health: Health;
  plex: PlexMonitor;
  scheduler: Scheduler;
  tools: ToolDefinition[];
  cards: Map<string, () => ToolCard | Promise<ToolCard>>;
  testers: Record<string, () => Promise<TestResult>>;
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { settings, jobs } = deps;

  const cardFor = async (id: string): Promise<ToolCard | null> => {
    const card = deps.cards.get(id);
    if (!card) return null;
    try {
      return await card();
    } catch {
      return { status: "warn", lines: ["Couldn't build this summary"] };
    }
  };

  app.get("/api/status", async (): Promise<StatusResponse> => {
    const tools: ToolSummary[] = await Promise.all(
      deps.tools.map(async (tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        card: await cardFor(tool.id),
      })),
    );
    return {
      version: deps.version,
      startedAt: deps.startedAt.toISOString(),
      health: deps.health.summary(),
      slots: jobs.slotStatuses(),
      plex: deps.plex.activity(),
      schedule: deps.scheduler.info(),
      tools,
    };
  });

  // Settings -----------------------------------------------------------------

  const settingsResponse = (): SettingsResponse => ({
    sections: settings.sections(),
    values: settings.publicValues(),
  });

  app.get("/api/settings", async () => settingsResponse());

  app.put<{ Params: { scope: string }; Body: SettingsUpdate }>(
    "/api/settings/:scope",
    async (request, reply) => {
      if (!settings.sections().some((s) => s.scope === request.params.scope)) {
        return reply.code(404).send({ error: "No such settings section" });
      }
      try {
        settings.update(request.params.scope, request.body ?? {});
      } catch (error) {
        if (error instanceof SettingsValidationError) {
          return reply.code(400).send({ error: error.message, fields: error.fields });
        }
        throw error;
      }
      return settingsResponse();
    },
  );

  app.post<{ Params: { scope: string } }>(
    "/api/integrations/:scope/test",
    async (request, reply) => {
      const test = deps.testers[request.params.scope];
      if (!test) return reply.code(404).send({ error: "Nothing to test here" });
      return test();
    },
  );

  // Jobs ---------------------------------------------------------------------

  app.get<{ Querystring: { limit?: string; tool?: string } }>("/api/jobs", async (request) =>
    jobs.list({ limit: Number(request.query.limit ?? 100), tool: request.query.tool }),
  );

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = jobs.get(Number(request.params.id));
    return job ?? reply.code(404).send({ error: "No such job" });
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const job = jobs.cancel(Number(request.params.id));
    return job ?? reply.code(404).send({ error: "No such job" });
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = jobs.retry(Number(request.params.id));
    return job ?? reply.code(404).send({ error: "No such job" });
  });

  // Live updates (server-sent events) ------------------------------------------

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops nginx (the reverse proxy) from buffering the stream.
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const unsubscribe = deps.events.subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
}
