import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import type { JobContext } from "../src/server/core/jobs.js";
import type { MissingItem } from "../src/server/integrations/arr.js";
import { pickItems, runSearch } from "../src/tools/missing/search.js";
import { MissingStore, migrations } from "../src/tools/missing/store.js";
import { tempDir } from "./helpers.js";

const job = {
  id: 1,
  payload: {},
  signal: new AbortController().signal,
  progress: () => {},
  log: () => {},
  checkpoint: async () => {},
  run: () => Promise.reject(new Error("no processes")),
} as JobContext<unknown>;

const item = (id: number, lastSearchTime: string | null): MissingItem => ({
  id,
  what: `Show S01E0${id}`,
  lastSearchTime,
});

const ITEMS = [
  item(1, "2026-11-09T00:00:00Z"),
  item(2, null),
  item(3, "2026-10-01T00:00:00Z"),
  item(4, "2026-11-01T00:00:00Z"),
];

function setup(options: { searchError?: Error } = {}) {
  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  migrate(db, "tool:missing", migrations);
  const store = new MissingStore(db);
  const calls: string[] = [];
  const arr = (app: "sonarr" | "radarr", configured: boolean) => ({
    app,
    name: app === "sonarr" ? "Sonarr" : "Radarr",
    configured: () => configured,
    missing: async () => ITEMS,
    queuedIds: async () => new Set([3]),
    search: async (ids: number[]) => {
      if (options.searchError) throw options.searchError;
      calls.push(`${app} ${ids.join()}`);
    },
  });
  return { store, calls, arrs: [arr("sonarr", true), arr("radarr", false)] };
}

describe("missing search", () => {
  it("picks never-searched items first, then the longest ago, skipping ones downloading", () => {
    expect(pickItems(ITEMS, new Set([3]), 2).map((i) => i.id)).toEqual([2, 4]);
    expect(pickItems(ITEMS, new Set(), 10).map((i) => i.id)).toEqual([2, 3, 4, 1]);
  });

  it("asks each configured app to search for a batch and records it", async () => {
    const t = setup();
    const result = await runSearch(job, {
      store: t.store,
      arrs: t.arrs,
      perRun: 2,
      now: () => Date.parse("2026-11-10T12:00:00Z"),
    });
    expect(result).toEqual({ searched: 2, missing: 3, failed: 0 });
    expect(t.calls).toEqual(["sonarr 2,4"]);
    expect(t.store.lastRunAt()).toBe("2026-11-10T12:00:00.000Z");
    expect(t.store.runs({ limit: 5 })).toMatchObject([
      { app: "sonarr", missing: 3, searched: ["Show S01E02", "Show S01E04"], error: null },
    ]);
  });

  it("records a failure and still counts the run, so it isn't retried every 10 minutes", async () => {
    const t = setup({ searchError: new Error("Sonarr is down") });
    const result = await runSearch(job, { store: t.store, arrs: t.arrs, perRun: 2 });
    expect(result.failed).toBe(1);
    expect(t.store.lastRunAt()).not.toBeNull();
    expect(t.store.runs({ limit: 1 })[0]).toMatchObject({ error: "Sonarr is down", searched: [] });
  });
});
