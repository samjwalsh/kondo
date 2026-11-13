import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import type { JobContext } from "../src/server/core/jobs.js";
import type { SettingsStore } from "../src/server/core/settings.js";
import { ArrClient, type MissingItem } from "../src/server/integrations/arr.js";
import { pickItems, runSearch } from "../src/tools/missing/search.js";
import { MissingStore, migrations } from "../src/tools/missing/store.js";
import { tempDir } from "./helpers.js";

const job = {
  id: 1,
  payload: {},
  signal: new AbortController().signal,
  progress: () => {},
  log: () => {},
  pausedMs: () => 0,
  checkpoint: async () => {},
  run: () => Promise.reject(new Error("no processes")),
} as JobContext<unknown>;

const item = (id: number, lastSearchTime: string | null): MissingItem => ({
  id,
  what: `Show S01E0${id}`,
  title: "Show",
  lastSearchTime,
});

const ITEMS = [
  item(1, "2026-11-09T00:00:00Z"),
  item(2, null),
  item(3, "2026-10-01T00:00:00Z"),
  item(4, "2026-11-01T00:00:00Z"),
];

const DUB = item(9, null);

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
    belowFormatCutoff: async () => [{ ...DUB, what: "Show S02E01 (No English or original audio)" }],
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
      upgrades: false,
      now: () => Date.parse("2026-11-10T12:00:00Z"),
    });
    expect(result).toEqual({ searched: 2, missing: 3, upgrades: 0, failed: 0 });
    expect(t.calls).toEqual(["sonarr 2,4"]);
    expect(t.store.lastRunAt()).toBe("2026-11-10T12:00:00.000Z");
    expect(t.store.runs({ limit: 5 })).toMatchObject([
      { app: "sonarr", missing: 3, upgrades: 0, searched: ["Show S01E02", "Show S01E04"] },
    ]);
  });

  it("gives files to replace a turn alongside the missing items", async () => {
    const t = setup();
    const result = await runSearch(job, {
      store: t.store,
      arrs: t.arrs,
      perRun: 3,
      upgrades: true,
    });
    expect(result).toMatchObject({ searched: 3, missing: 3, upgrades: 1 });
    // Never searched: the missing S01E02 and the dub, then the longest ago.
    expect(t.calls).toEqual(["sonarr 2,9,4"]);
    expect(t.store.runs({ limit: 1 })[0]).toMatchObject({
      upgrades: 1,
      searched: ["Show S01E02", "Show S02E01 (No English or original audio)", "Show S01E04"],
    });
  });

  it("records a failure and still counts the run, so it isn't retried every 10 minutes", async () => {
    const t = setup({ searchError: new Error("Sonarr is down") });
    const result = await runSearch(job, {
      store: t.store,
      arrs: t.arrs,
      perRun: 2,
      upgrades: true,
    });
    expect(result.failed).toBe(1);
    expect(t.store.lastRunAt()).not.toBeNull();
    expect(t.store.runs({ limit: 1 })[0]).toMatchObject({ error: "Sonarr is down", searched: [] });
  });
});

describe("files Sonarr/Radarr would replace", () => {
  /** A client whose API answers come from `routes`. */
  function client(app: "sonarr" | "radarr", routes: Record<string, unknown>) {
    const c = new ArrClient(app, {} as SettingsStore);
    const asked: string[] = [];
    c.get = async <T>(path: string) => {
      asked.push(path);
      if (!(path in routes)) throw new Error(`unexpected ${path}`);
      return routes[path] as T;
    };
    return { c, asked };
  }
  const profiles = [
    { id: 4, upgradeAllowed: true, cutoffFormatScore: 0, formatItems: [{ score: -1000 }] },
    { id: 5, upgradeAllowed: false, cutoffFormatScore: 0, formatItems: [{ score: -1000 }] },
    { id: 6, upgradeAllowed: true, cutoffFormatScore: 0, formatItems: [{ score: 0 }] },
  ];
  const dub = { name: "No English or original audio" };

  it("lists monitored episodes whose file scores below the cutoff, in profiles that upgrade", async () => {
    const { c, asked } = client("sonarr", {
      "/qualityprofile": profiles,
      "/series": [
        { id: 1, title: "Family Guy", monitored: true, qualityProfileId: 4 },
        { id: 2, title: "No Upgrades", monitored: true, qualityProfileId: 5 },
        { id: 3, title: "No Scores", monitored: true, qualityProfileId: 6 },
        { id: 4, title: "Unmonitored", monitored: false, qualityProfileId: 4 },
      ],
      "/episodefile?seriesId=1": [
        { id: 10, customFormatScore: -1000, customFormats: [dub] },
        { id: 11, customFormatScore: 0, customFormats: [] },
        { id: 12, customFormatScore: -1000, customFormats: [dub] },
      ],
      "/episode?seriesId=1": [
        { id: 100, seasonNumber: 16, episodeNumber: 1, monitored: true, episodeFileId: 10 },
        { id: 101, seasonNumber: 16, episodeNumber: 2, monitored: true, episodeFileId: 11 },
        { id: 102, seasonNumber: 1, episodeNumber: 1, monitored: false, episodeFileId: 12 },
        { id: 103, seasonNumber: 16, episodeNumber: 3, monitored: true },
      ],
    });
    expect(await c.belowFormatCutoff()).toEqual([
      {
        id: 100,
        what: "Family Guy S16E01 (No English or original audio)",
        title: "Family Guy",
        lastSearchTime: null,
      },
    ]);
    // Series in profiles that can't upgrade aren't even looked at.
    expect(asked.filter((p) => p.startsWith("/episodefile"))).toEqual(["/episodefile?seriesId=1"]);
  });

  it("does the same for movies", async () => {
    const { c } = client("radarr", {
      "/qualityprofile": profiles,
      "/movie": [
        {
          id: 1,
          title: "Dubbed",
          year: 2020,
          monitored: true,
          hasFile: true,
          qualityProfileId: 4,
        },
        {
          id: 2,
          title: "Fine",
          monitored: true,
          hasFile: true,
          qualityProfileId: 4,
        },
        { id: 3, title: "Missing", monitored: true, hasFile: false, qualityProfileId: 4 },
      ],
      "/moviefile?movieId=1&movieId=2": [
        { id: 11, movieId: 1, customFormatScore: -1000, customFormats: [dub] },
        { id: 12, movieId: 2, customFormatScore: 0 },
      ],
    });
    expect(await c.belowFormatCutoff()).toEqual([
      {
        id: 1,
        what: "Dubbed (2020) (No English or original audio)",
        title: "Dubbed (2020)",
        lastSearchTime: null,
      },
    ]);
  });

  it("asks nothing more when no profile both upgrades and scores custom formats", async () => {
    const { c, asked } = client("sonarr", { "/qualityprofile": [profiles[1], profiles[2]] });
    expect(await c.belowFormatCutoff()).toEqual([]);
    expect(asked).toEqual(["/qualityprofile"]);
  });
});

describe("Kondo's own record of searches", () => {
  it("takes turns even when Sonarr/Radarr don't say when they last searched", async () => {
    const db = openDb(tempDir());
    migrate(db, "core", coreMigrations);
    migrate(db, "tool:missing", migrations);
    const store = new MissingStore(db);
    const calls: number[][] = [];
    const arr = {
      app: "radarr" as const,
      name: "Radarr",
      configured: () => true,
      missing: async () => [],
      belowFormatCutoff: async () => [1, 2, 3].map((id) => item(id, null)),
      queuedIds: async () => new Set<number>(),
      search: async (ids: number[]) => {
        calls.push(ids);
      },
    };
    let now = Date.parse("2026-11-10T00:00:00Z");
    for (let run = 0; run < 3; run++) {
      await runSearch(job, { store, arrs: [arr], perRun: 2, upgrades: true, now: () => now });
      now += 86_400_000;
    }
    // Day 3: 2 was searched longest ago; 1 and 3 tie, in list order.
    expect(calls).toEqual([
      [1, 2],
      [3, 1],
      [2, 1],
    ]);
  });
});
