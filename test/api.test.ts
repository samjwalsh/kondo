import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKondo, type Kondo } from "../src/server/kondo.js";
import diagnostics from "../src/tools/diagnostics/server.js";
import { testConfig } from "./helpers.js";

const started: Kondo[] = [];

afterEach(async () => {
  for (const k of started.splice(0)) await k.stop();
});

async function kondo(options: Parameters<typeof createKondo>[1] = {}, webDir?: string) {
  const k = await createKondo(testConfig(webDir ? { webDir } : {}), {
    background: false,
    tools: [],
    ...options,
  });
  await k.start();
  started.push(k);
  return k;
}

describe("api", () => {
  it("reports health with the running version", async () => {
    const { app } = await kondo();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", version: "dev" });
  });

  it("returns a dashboard snapshot", async () => {
    const { app, health } = await kondo();
    await health.evaluate();
    const res = await app.inject({ method: "GET", url: "/api/status" });
    const body = res.json();
    expect(body.slots.map((s: { id: string }) => s.id)).toEqual(["gpu", "cpu", "general"]);
    expect(body.slots[0].allowed).toBe(false); // Plex isn't set up
    expect(body.plex.configured).toBe(false);
    expect(body.health.checks.find((c: { id: string }) => c.id === "plex").status).toBe("warn");
  });

  it("validates settings and never returns secrets", async () => {
    const { app } = await kondo();
    const bad = await app.inject({
      method: "PUT",
      url: "/api/settings/schedule",
      payload: { windowStart: "25:00" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields.windowStart).toBeTruthy();

    const ok = await app.inject({
      method: "PUT",
      url: "/api/settings/plex",
      payload: { token: "super-secret" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain("super-secret");
    expect(ok.json().values.plex.token).toEqual({ set: true });
  });

  it("explains what's missing when testing an unconfigured integration", async () => {
    const { app } = await kondo();
    const res = await app.inject({ method: "POST", url: "/api/integrations/sonarr/test" });
    expect(res.json()).toEqual({ ok: false, message: "Fill in the address and API key first." });
  });

  it("mounts tool routes and queues their jobs", async () => {
    const { app } = await kondo({ tools: [diagnostics] });
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/diagnostics/test",
      payload: { slot: "cpu", seconds: 10 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ tool: "diagnostics", slot: "cpu", state: "queued" });
    const jobs = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(jobs.json()).toHaveLength(1);
  });
});

describe("web UI routing", () => {
  const webDir = mkdtempSync(path.join(tmpdir(), "kondo-web-"));
  writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>Kondo</title>");

  it("serves the app for page paths", async () => {
    const { app } = await kondo({}, webDir);
    const res = await app.inject({ method: "GET", url: "/jobs" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Kondo</title>");
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const { app } = await kondo({}, webDir);
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });
});
