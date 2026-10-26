import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "../../shared/api.js";
import type { Config } from "../config.js";

export function registerHealthRoutes(app: FastifyInstance, config: Config): void {
  const startedAt = new Date();

  app.get("/api/health", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      version: config.version,
      node: process.version,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    };
  });
}
