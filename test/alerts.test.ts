import { describe, expect, it } from "vitest";
import { Alerts } from "../src/server/core/notify.js";
import type { HealthStatus, HealthSummary } from "../src/shared/api.js";
import { log } from "./helpers.js";

function summary(status: HealthStatus): HealthSummary {
  return {
    overall: status,
    checks: [
      {
        id: "plex",
        label: "Plex",
        status,
        message: status === "error" ? "down" : "fine",
        checkedAt: "",
      },
    ],
  };
}

describe("alerts", () => {
  it("waits for a second failing check, reminds, then announces recovery", async () => {
    const sent: string[] = [];
    const alerts = new Alerts(
      { configured: () => true, send: async (t) => void sent.push(t) },
      log,
      2,
      1000,
    );

    await alerts.onHealth(summary("error"), 0);
    expect(sent).toEqual([]);
    await alerts.onHealth(summary("error"), 60);
    expect(sent).toEqual(["⚠️ Kondo — Plex: down"]);
    await alerts.onHealth(summary("error"), 500);
    expect(sent).toHaveLength(1);
    await alerts.onHealth(summary("error"), 1100);
    expect(sent).toHaveLength(2);
    await alerts.onHealth(summary("ok"), 1200);
    expect(sent.at(-1)).toBe("✅ Kondo — Plex is OK again.");
  });

  it("stays quiet about a blip that clears before it's confirmed", async () => {
    const sent: string[] = [];
    const alerts = new Alerts(
      { configured: () => true, send: async (t) => void sent.push(t) },
      log,
    );
    await alerts.onHealth(summary("error"));
    await alerts.onHealth(summary("ok"));
    expect(sent).toEqual([]);
  });

  it("ignores warnings", async () => {
    const sent: string[] = [];
    const alerts = new Alerts(
      { configured: () => true, send: async (t) => void sent.push(t) },
      log,
      1,
    );
    await alerts.onHealth(summary("warn"));
    expect(sent).toEqual([]);
  });
});
