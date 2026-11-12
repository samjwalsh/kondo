import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import type { SettingsStore } from "../src/server/core/settings.js";
import { ArrClient, type MissingItem, type QueueProblem } from "../src/server/integrations/arr.js";
import type { UnmatchedItem } from "../src/server/integrations/plex.js";
import { attentionStatus, ping, runCheck, summaryLines } from "../src/tools/attention/check.js";
import { AttentionStore, migrations } from "../src/tools/attention/store.js";
import { tempDir } from "./helpers.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-10T12:00:00Z");
const LIMITS = { stuckDays: 1, stuckHours: 6 };

const episode = (id: number, title: string, n: number): MissingItem => ({
  id,
  what: `${title} S01E0${n}`,
  title,
  lastSearchTime: null,
});

function setup() {
  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  migrate(db, "tool:attention", migrations);
  const store = new AttentionStore(db);
  const state = {
    missing: [episode(1, "Show", 1), episode(2, "Show", 2)] as MissingItem[],
    replace: [episode(3, "Family Guy", 1)] as MissingItem[],
    queued: new Set<number>(),
    queue: [
      { id: 50, what: "Other S02E01", release: "x", problem: "Unable to match", stalled: false },
      {
        id: 51,
        what: "Old Show S01E03",
        release: "y",
        problem: "The download is stalled with no connections",
        stalled: true,
      },
    ] as QueueProblem[],
    health: [
      { source: "AllowedHostsCheck", message: "Allowed Hosts is not configured" },
      {
        source: "IndexerStatusCheck",
        message: "Indexers unavailable due to failures: LimeTorrents",
      },
    ],
    sonarrDown: false,
    bazarrDown: false,
  };
  const sonarr = {
    app: "sonarr" as const,
    name: "Sonarr",
    configured: () => true,
    missing: async () => {
      if (state.sonarrDown) throw new Error("Nothing is listening");
      return state.missing;
    },
    belowFormatCutoff: async () => state.replace,
    queuedIds: async () => state.queued,
    queueProblems: async () => state.queue,
    healthIssues: async () => state.health,
  };
  let now = T0;
  const check = () =>
    runCheck({
      store,
      arrs: [sonarr],
      ignoreHealth: ["AllowedHostsCheck"],
      services: [
        { app: "bazarr", name: "Bazarr", url: "http://bazarr" },
        { app: "seerr", name: "Seerr", url: "" },
      ],
      ping: async () => {
        if (state.bazarrDown) throw new Error("Nothing is listening at bazarr");
      },
      now: () => now,
    });
  return {
    store,
    state,
    check,
    at: (ms: number) => {
      now = ms;
    },
    status: () => attentionStatus(store, LIMITS, now),
  };
}

describe("needs a look", () => {
  it("stays quiet about problems that haven't lasted", async () => {
    const t = setup();
    await t.check();
    const s = t.status();
    expect(s.due).toEqual([]);
    // 2 missing, 1 to replace, 1 failed import, 1 stalled download, 1 health warning
    expect(s.watching).toBe(6);
    expect(summaryLines(s)).toEqual([]);
  });

  it("reports what has lasted, keeping the first time it was seen", async () => {
    const t = setup();
    await t.check();
    t.at(T0 + 7 * 3_600_000);
    await t.check();
    expect(
      t
        .status()
        .due.map((i) => i.kind)
        .sort(),
    ).toEqual(["health", "import"]);

    t.at(T0 + DAY);
    await t.check();
    expect(summaryLines(t.status())).toEqual([
      "Needs a look:",
      "• Not found or not finished after a day: Show (2 episodes)",
      "• Still waiting for a better copy (e.g. not just a dub) after a day: Family Guy (1 episode)",
      "• Download stuck for a day: Old Show S01E03 (The download is stalled with no connections)",
      "• Stuck in the download queue for 6+ h: Other S02E01 (Sonarr: Unable to match)",
      "• Sonarr: Indexers unavailable due to failures: LimeTorrents",
    ]);
  });

  it("keeps the clock running while a replacement downloads, fails and is tried again", async () => {
    const t = setup();
    await t.check();
    t.state.queued = new Set([3]);
    t.at(T0 + 12 * 3_600_000);
    await t.check();
    t.state.queued = new Set(); // that attempt failed
    t.at(T0 + 13 * 3_600_000);
    await t.check();
    t.state.queued = new Set([3]); // another one
    t.at(T0 + DAY);
    await t.check();
    const item = t.status().due.find((i) => i.what === "Family Guy S01E01");
    expect(item).toMatchObject({ firstSeen: new Date(T0).toISOString(), detail: "Downloading" });
  });

  it("forgets a problem once it's gone, and starts again if it comes back", async () => {
    const t = setup();
    await t.check();
    t.state.replace = []; // replaced
    t.at(T0 + DAY);
    await t.check();
    expect(t.store.items().some((i) => i.kind === "replace")).toBe(false);
    t.state.replace = [episode(3, "Family Guy", 1)];
    await t.check();
    const back = t.store.items().find((i) => i.what === "Family Guy S01E01");
    expect(back?.firstSeen).toBe(new Date(T0 + DAY).toISOString());
  });

  it("only counts a film once it's out at home, not just in cinemas", async () => {
    const t = setup();
    t.state.missing = [
      { ...episode(7, "In Cinemas (2026)", 1), what: "In Cinemas (2026)", homeRelease: null },
      {
        ...episode(8, "Out (2026)", 1),
        what: "Out (2026)",
        homeRelease: "2026-11-01T00:00:00Z",
      },
    ];
    await t.check();
    expect(
      t.store
        .items()
        .filter((i) => i.kind === "not-found")
        .map((i) => i.what),
    ).toEqual(["Out (2026)"]);
  });

  it("keeps what it knew when a source can't be read, and says so", async () => {
    const t = setup();
    await t.check();
    t.state.sonarrDown = true;
    t.at(T0 + DAY);
    const { errors } = await t.check();
    expect(errors).toEqual(["Sonarr wanted list: Nothing is listening"]);
    expect(t.status().due.filter((i) => i.kind === "not-found")).toHaveLength(2);
    expect(t.status().errors).toEqual(errors);
  });

  it("reports a service only after it's been down for an hour", async () => {
    const t = setup();
    t.state.bazarrDown = true;
    await t.check();
    expect(t.status().due.filter((i) => i.kind === "service")).toEqual([]);
    t.at(T0 + 3_600_000);
    await t.check();
    expect(summaryLines(t.status())).toContain(
      "• Bazarr isn't answering (Nothing is listening at bazarr)",
    );
    t.state.bazarrDown = false;
    await t.check();
    expect(t.store.items().filter((i) => i.kind === "service")).toEqual([]);
  });

  it("shortens long lists", async () => {
    const t = setup();
    t.state.missing = Array.from({ length: 7 }, (_, i) => episode(100 + i, `Show ${i}`, 1));
    t.state.replace = [];
    t.state.queue = [];
    t.state.health = [];
    await t.check();
    t.at(T0 + DAY);
    expect(summaryLines(t.status())[1]).toBe(
      "• Not found or not finished after a day: Show 0 (1 episode), Show 1 (1 episode), Show 2 (1 episode), Show 3 (1 episode) and 3 more",
    );
  });
});

describe("items Plex couldn't match", () => {
  it("reports them after the hours limit, and forgets them once matched", async () => {
    const db = openDb(tempDir());
    migrate(db, "core", coreMigrations);
    migrate(db, "tool:attention", migrations);
    const store = new AttentionStore(db);
    let unmatched: UnmatchedItem[] = [
      { id: "91277", title: "Warrior (2011)", library: "Movies" },
      { id: "91278", title: "The Last of Us (2023)", library: "Sam's TV" },
    ];
    let configured = true;
    let now = T0;
    const check = () =>
      runCheck({
        store,
        arrs: [],
        ignoreHealth: [],
        services: [],
        plex: { configured: () => configured, unmatched: async () => unmatched },
        now: () => now,
      });

    await check();
    expect(attentionStatus(store, LIMITS, now).due).toEqual([]);
    now = T0 + 6 * 3_600_000;
    await check();
    expect(summaryLines(attentionStatus(store, LIMITS, now))).toEqual([
      "Needs a look:",
      "• Not matched in Plex for 6+ h (⋯ → Match…): Warrior (2011), The Last of Us (2023)",
    ]);

    unmatched = unmatched.slice(1);
    await check();
    expect(store.items().map((i) => i.what)).toEqual(["The Last of Us (2023)"]);

    configured = false;
    await check();
    expect(store.items()).toEqual([]);
  });
});

describe("Sonarr/Radarr queue and health", () => {
  function client(routes: Record<string, unknown>) {
    const c = new ArrClient("sonarr", {} as SettingsStore);
    c.get = async <T>(path: string) => {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) throw new Error(`unexpected ${path}`);
      return routes[key] as T;
    };
    return c;
  }

  it("lists downloads that can't be imported, or aren't moving", async () => {
    const c = client({
      "/queue": {
        records: [
          {
            id: 1,
            title: "fine",
            trackedDownloadStatus: "ok",
            trackedDownloadState: "downloading",
          },
          {
            id: 2,
            title: "Show.S01E02.1080p",
            trackedDownloadStatus: "warning",
            trackedDownloadState: "importBlocked",
            statusMessages: [{ title: "x", messages: ["Unable to match the episode"] }],
            series: { title: "Show" },
            episode: { seasonNumber: 1, episodeNumber: 2 },
          },
          {
            id: 3,
            title: "Unknown.Thing",
            trackedDownloadStatus: "ok",
            trackedDownloadState: "importPending",
          },
          {
            id: 4,
            title: "Old.Show.S01E03.TL",
            status: "warning",
            trackedDownloadStatus: "ok",
            trackedDownloadState: "downloading",
            errorMessage: "The download is stalled with no connections",
            series: { title: "Old Show" },
            episode: { seasonNumber: 1, episodeNumber: 3 },
          },
        ],
      },
    });
    expect(await c.queueProblems()).toEqual([
      {
        id: 2,
        what: "Show S01E02",
        release: "Show.S01E02.1080p",
        problem: "Unable to match the episode",
        stalled: false,
      },
      {
        id: 3,
        what: "Unknown.Thing",
        release: "Unknown.Thing",
        problem: "importPending",
        stalled: false,
      },
      {
        id: 4,
        what: "Old Show S01E03",
        release: "Old.Show.S01E03.TL",
        problem: "The download is stalled with no connections",
        stalled: true,
      },
    ]);
  });

  it("keeps warnings and errors from the health page", async () => {
    const c = client({
      "/health": [
        { source: "A", type: "notice", message: "n" },
        { source: "B", type: "warning", message: "w" },
        { source: "C", type: "error", message: "e" },
      ],
    });
    expect(await c.healthIssues()).toEqual([
      { source: "B", message: "w" },
      { source: "C", message: "e" },
    ]);
  });
});

describe("pinging a service", () => {
  it("counts any answer below 500 as up, and no answer or a 5xx as down", async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.url === "/broken" ? 503 : 401;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(ping(`http://127.0.0.1:${port}/`)).resolves.toBeUndefined();
      await expect(ping(`http://127.0.0.1:${port}/broken`)).rejects.toThrow("HTTP 503");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    await expect(ping(`http://127.0.0.1:${port}/`)).rejects.toThrow("127.0.0.1");
  });
});

describe("a film's home release", () => {
  it("is the earliest digital or disc date that has passed", async () => {
    const c = new ArrClient("radarr", {} as SettingsStore);
    c.get = async <T>() =>
      ({
        totalRecords: 3,
        records: [
          { id: 1, title: "Cinema Only", year: 2026, digitalRelease: "2999-01-01T00:00:00Z" },
          {
            id: 2,
            title: "Out",
            year: 2026,
            digitalRelease: "2026-02-01T00:00:00Z",
            physicalRelease: "2026-01-15T00:00:00Z",
          },
          { id: 3, title: "No Dates", year: 2026 },
        ],
      }) as T;
    expect((await c.missing()).map((i) => [i.what, i.homeRelease])).toEqual([
      ["Cinema Only (2026)", null],
      ["Out (2026)", "2026-01-15T00:00:00Z"],
      ["No Dates (2026)", null],
    ]);
  });
});
