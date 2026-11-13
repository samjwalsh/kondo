import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import type { JobContext } from "../src/server/core/jobs.js";
import type { GrabRecord } from "../src/server/integrations/arr.js";
import type { Torrent, TorrentFile } from "../src/server/integrations/qbittorrent.js";
import {
  blockedFiles,
  DEFAULT_BLOCKED,
  runCheck,
  type StuckRules,
} from "../src/tools/downloads/check.js";
import type { DownloadsMode } from "../src/tools/downloads/shared.js";
import { DownloadsStore, migrations } from "../src/tools/downloads/store.js";
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

const file = (name: string, priority = 1): TorrentFile => ({ name, size: 1e9, priority });

const FAKE: Torrent = {
  hash: "f254d6c6aa",
  name: "NCIS S24E04 Like Subscribe 1080p WEB H264-FLUX",
  category: "sonarr",
  state: "uploading",
  size: 1.1e9,
  contentPath: "/plex/temp/NCIS S24E04 Like Subscribe 1080p WEB H264-FLUX",
  progress: 1,
  downloaded: 1.1e9,
  timeActive: 3600,
  private: false,
};
const REAL: Torrent = { ...FAKE, hash: "aa11", name: "NCIS.S20.1080p.AMZN.WEB-DL" };
const MINE: Torrent = { ...FAKE, hash: "bb22", name: "Some installer", category: "" };

const OFF: StuckRules = {
  mode: "off",
  metadataMinutes: 60,
  noProgressHours: 6,
  leavePrivate: true,
};

function setup(
  mode: DownloadsMode,
  options: {
    markFailedError?: Error;
    noGrab?: boolean;
    torrents?: Torrent[];
    stuck?: StuckRules;
    now?: () => number;
  } = {},
) {
  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  migrate(db, "tool:downloads", migrations);
  const store = new DownloadsStore(db);
  const calls: string[] = [];
  const files: Record<string, TorrentFile[]> = {
    [FAKE.hash]: [
      file("NCIS S24E04 Like Subscribe 1080p WEB H264-FLUX/NCIS S24E04.exe", 0),
      file("NCIS S24E04 Like Subscribe 1080p WEB H264-FLUX/vis/Countdown.S01E07.mkv"),
    ],
    [REAL.hash]: [file("NCIS.S20.1080p.AMZN.WEB-DL/NCIS.S20E01.mkv")],
    [MINE.hash]: [file("setup.exe")],
  };
  const grab: GrabRecord = {
    id: 77,
    sourceTitle: FAKE.name,
    what: "NCIS S24E04",
    indexer: "Nyaa.si (Prowlarr)",
  };
  const deps = {
    store,
    qbittorrent: {
      torrents: async () => options.torrents ?? [FAKE, REAL, MINE],
      files: async (hash: string) => files[hash] ?? [],
      deleteWithFiles: async (hashes: string[]) => void calls.push(`delete ${hashes.join()}`),
    },
    arrs: [
      {
        app: "sonarr" as const,
        name: "Sonarr",
        configured: () => true,
        grabOf: async (hash: string) =>
          hash !== REAL.hash && !options.noGrab
            ? { ...grab, id: hash === FAKE.hash ? 77 : 88 }
            : null,
        markFailed: async (id: number) => {
          if (options.markFailedError) throw options.markFailedError;
          calls.push(`markFailed ${id}`);
        },
      },
    ],
    mode,
    categories: ["sonarr", "radarr"],
    extensions: DEFAULT_BLOCKED,
    stuck: options.stuck ?? OFF,
    now: options.now,
  };
  return { store, calls, deps };
}

describe("fake downloads", () => {
  it("spots programs among a torrent's files, even ones qBittorrent skipped", () => {
    expect(blockedFiles([file("a/Episode.EXE", 0), file("a/vis/x.mkv")], DEFAULT_BLOCKED)).toEqual([
      "Episode.EXE",
    ]);
    expect(blockedFiles([file("Show.S01E01.mkv"), file("Show.nfo")], DEFAULT_BLOCKED)).toEqual([]);
    expect(blockedFiles([file("a/run.lnk")], ["*.lnk"])).toEqual(["run.lnk"]);
  });

  it("only reports in report mode, once, and leaves other categories alone", async () => {
    const t = setup("report");
    const result = await runCheck(job, t.deps);
    expect(result).toEqual({
      torrents: 2,
      fakes: 1,
      stuck: 0,
      removed: 0,
      failed: 0,
      left: { fakes: 1, stuck: 0 },
    });
    expect(t.calls).toEqual([]);
    await runCheck(job, t.deps);
    expect(t.store.entries({ limit: 10 })).toMatchObject([
      { action: "found", what: "NCIS S24E04", app: "sonarr", badFiles: ["NCIS S24E04.exe"] },
    ]);
  });

  it("blocklists in Sonarr first, then deletes the torrent", async () => {
    const t = setup("remove");
    const result = await runCheck(job, t.deps);
    expect(result).toMatchObject({ fakes: 1, removed: 1 });
    expect(t.calls).toEqual(["markFailed 77", `delete ${FAKE.hash}`]);
    expect(t.store.entries({ limit: 10 })[0]).toMatchObject({
      action: "removed",
      indexer: "Nyaa.si (Prowlarr)",
      detail: expect.stringMatching(/looking for another release/),
    });
  });

  it("keeps the torrent if Sonarr can't be told, and says so only once", async () => {
    const t = setup("remove", { markFailedError: new Error("Sonarr is down") });
    await runCheck(job, t.deps);
    await runCheck(job, t.deps);
    expect(t.calls).toEqual([]);
    const entries = t.store.entries({ limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "error",
      detail: "Couldn't remove it: Sonarr is down",
    });
  });

  it("still removes a fake that Sonarr has no record of", async () => {
    const t = setup("remove", { noGrab: true });
    await runCheck(job, t.deps);
    expect(t.calls).toEqual([`delete ${FAKE.hash}`]);
    expect(t.store.entries({ limit: 1 })[0]?.detail).toMatch(/only removed from qBittorrent/);
  });
});

const HOUR = 3_600_000;
const NO_FILE_LIST: Torrent = {
  ...REAL,
  hash: "cc33",
  name: "South.Park.S29E05.1080p.AMZN.WEB-DL.DDP5.1.H.264-RARBG",
  state: "metaDL",
  size: 0,
  progress: 0,
  downloaded: 0,
  timeActive: 4 * 24 * 3600,
  private: null,
};
const STALLED: Torrent = {
  ...REAL,
  hash: "dd44",
  name: "MobLand.S02E09.1080p",
  state: "stalledDL",
  progress: 0.42,
  downloaded: 4e8,
  timeActive: 3 * 24 * 3600,
};
const RULES: StuckRules = {
  mode: "remove",
  metadataMinutes: 60,
  noProgressHours: 6,
  leavePrivate: true,
};

describe("stuck downloads", () => {
  it("removes a download that never got its file list, after blocklisting it", async () => {
    const t = setup("remove", { torrents: [NO_FILE_LIST], stuck: RULES });
    const result = await runCheck(job, t.deps);
    expect(result).toMatchObject({ stuck: 1, removed: 1, left: { stuck: 0 } });
    expect(t.calls).toEqual(["markFailed 88", `delete ${NO_FILE_LIST.hash}`]);
    expect(t.store.entries({ limit: 1 })[0]).toMatchObject({
      kind: "stuck",
      action: "removed",
      problem: "No file list after 4 days",
      badFiles: [],
    });
  });

  it("gives a new magnet link time to get its file list", async () => {
    const t = setup("remove", {
      torrents: [{ ...NO_FILE_LIST, timeActive: 20 * 60 }],
      stuck: RULES,
    });
    expect(await runCheck(job, t.deps)).toMatchObject({ stuck: 0 });
    expect(t.calls).toEqual([]);
  });

  it("counts hours without progress from when Kondo saw it move, not stopped time", async () => {
    let now = Date.parse("2026-11-10T00:00:00Z");
    let torrent = STALLED;
    const t = setup("remove", { torrents: [], stuck: RULES, now: () => now });
    t.deps.qbittorrent.torrents = async () => [torrent];

    await runCheck(job, t.deps); // first sighting starts the clock
    now += 5 * HOUR;
    expect(await runCheck(job, t.deps)).toMatchObject({ stuck: 0 });

    torrent = { ...STALLED, downloaded: STALLED.downloaded + 1e6 }; // moved: clock restarts
    now += 2 * HOUR;
    expect(await runCheck(job, t.deps)).toMatchObject({ stuck: 0 });

    torrent = { ...torrent, state: "stoppedDL" }; // stopped: forgotten
    now += 10 * HOUR;
    expect(await runCheck(job, t.deps)).toMatchObject({ stuck: 0 });
    torrent = { ...torrent, state: "stalledDL" };
    await runCheck(job, t.deps);
    now += 5 * HOUR;
    expect(await runCheck(job, t.deps)).toMatchObject({ stuck: 0 });

    now += 2 * HOUR;
    expect(await runCheck(job, t.deps)).toMatchObject({ stuck: 1, removed: 1 });
    expect(t.store.entries({ limit: 1 })[0]?.problem).toBe("No progress for 7 hours at 42%");
  });

  it("leaves private-tracker downloads, finished ones and queued ones alone", async () => {
    const t = setup("remove", {
      torrents: [
        { ...NO_FILE_LIST, hash: "p1", private: true },
        { ...NO_FILE_LIST, hash: "q1", state: "queuedDL" },
        { ...NO_FILE_LIST, hash: "s1", state: "stalledUP", progress: 1 },
      ],
      stuck: RULES,
    });
    expect(await runCheck(job, t.deps)).toMatchObject({ stuck: 0 });
    expect(t.calls).toEqual([]);
  });

  it("only reports in report mode, once, and keeps fakes on their own setting", async () => {
    const t = setup("off", {
      torrents: [FAKE, NO_FILE_LIST],
      stuck: { ...RULES, mode: "report" },
    });
    await runCheck(job, t.deps);
    const result = await runCheck(job, t.deps);
    expect(result).toMatchObject({ fakes: 0, stuck: 1, removed: 0, left: { stuck: 1 } });
    expect(t.calls).toEqual([]);
    expect(t.store.entries({ limit: 10 })).toMatchObject([{ kind: "stuck", action: "found" }]);
  });
});
