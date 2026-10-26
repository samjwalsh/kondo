import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  // Per-request logs would flood the journal (the UI polls health every 10 s).
  const app = Fastify({ logger: { level: config.logLevel }, disableRequestLogging: true });

  registerHealthRoutes(app, config);

  // Serve the built web UI when it exists (it doesn't in tests or `dev:server`).
  const hasWeb = existsSync(`${config.webDir}/index.html`);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDir });
  }

  app.setNotFoundHandler((request, reply) => {
    // Unknown API routes are real 404s; any other path is a page of the single-page app.
    if (request.url.startsWith("/api/") || !hasWeb) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });

  return app;
}
