import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createKondo, type Kondo } from "../src/server/kondo.js";
import { testConfig } from "./helpers.js";

const started: Kondo[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const k of started.splice(0)) await k.stop();
  for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
});

async function kondo() {
  const k = await createKondo(testConfig(), { background: false, tools: [] });
  await k.start();
  started.push(k);
  return k;
}

/** A fake Sonarr that records the commands it's sent. */
async function fakeArr(status = 201) {
  const commands: { url: string; key: string | undefined; body: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      commands.push({
        url: request.url ?? "",
        key: request.headers["x-api-key"] as string | undefined,
        body: JSON.parse(body || "null"),
      });
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 1 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, commands };
}

const finished = (k: Kondo, category: string) =>
  k.app.inject({
    method: "POST",
    url: `/api/hooks/download-finished?category=${encodeURIComponent(category)}`,
  });

describe("download-finished hook", () => {
  it("tells the app that owns the category to check its downloads", async () => {
    const arr = await fakeArr();
    const k = await kondo();
    k.settings.update("sonarr", { url: arr.url, apiKey: "sonarr-key" });

    const res = await finished(k, "sonarr");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ told: "Sonarr" });
    expect(arr.commands).toEqual([
      {
        url: "/api/v3/command",
        key: "sonarr-key",
        body: { name: "RefreshMonitoredDownloads" },
      },
    ]);
  });

  it("ignores other categories and apps that aren't set up", async () => {
    const k = await kondo();
    expect((await finished(k, "software")).json()).toMatchObject({ told: null });
    expect((await finished(k, "")).json()).toMatchObject({ told: null });
    expect((await finished(k, "radarr")).json()).toEqual({
      told: null,
      note: "Radarr isn't set up in Kondo",
    });
  });

  it("answers 502 when the app can't be reached", async () => {
    const arr = await fakeArr(500);
    const k = await kondo();
    k.settings.update("radarr", { url: arr.url, apiKey: "radarr-key" });
    const res = await finished(k, "radarr");
    expect(res.statusCode).toBe(502);
    expect(res.json().told).toBeNull();
  });
});
