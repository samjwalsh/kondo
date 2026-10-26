import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// In the bundle, the web UI sits next to the server: dist/server/main.mjs + dist/web/.
const defaultWebDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");

const schema = z.object({
  KONDO_HOST: z.string().default("0.0.0.0"),
  KONDO_PORT: z.coerce.number().int().min(1).max(65535).default(4242),
  KONDO_DATA_DIR: z.string().default("data"),
  KONDO_WEB_DIR: z.string().default(defaultWebDir),
  KONDO_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  webDir: string;
  logLevel: string;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    host: parsed.KONDO_HOST,
    port: parsed.KONDO_PORT,
    dataDir: path.resolve(parsed.KONDO_DATA_DIR),
    webDir: path.resolve(parsed.KONDO_WEB_DIR),
    logLevel: parsed.KONDO_LOG_LEVEL,
    version: process.env.KONDO_VERSION ?? "dev",
  };
}
