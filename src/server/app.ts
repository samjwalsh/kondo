import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { Config } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // The UI polls health every 10 s; logging those would flood the journal.
    // (Turning request logging off entirely would also hide request errors.)
    logController: new LogController({
      disableRequestLogging: (request) => request.url === "/api/health",
    }),
  });

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
