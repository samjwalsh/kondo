import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { type Config, loadConfig } from "../src/server/config.js";

/** A logger that discards everything. */
export const log = Fastify({ logger: false }).log;

export function tempDir(prefix = "kondo-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    dataDir: tempDir(),
    webDir: "/nonexistent",
    logLevel: "error",
    ...overrides,
  };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
