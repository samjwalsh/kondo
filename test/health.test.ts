import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

function testConfig(webDir: string) {
  return { ...loadConfig({}), webDir, logLevel: "error" };
}

describe("health", () => {
  it("reports ok with the running version", async () => {
    const app = await buildApp(testConfig("/nonexistent"));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", version: "dev" });
    await app.close();
  });
});

describe("web UI routing", () => {
  const webDir = mkdtempSync(path.join(tmpdir(), "kondo-web-"));
  writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>Kondo</title>");

  it("serves the app for page paths", async () => {
    const app = await buildApp(testConfig(webDir));
    const res = await app.inject({ method: "GET", url: "/transcode/queue" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Kondo</title>");
    await app.close();
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const app = await buildApp(testConfig(webDir));
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
    await app.close();
  });
});
