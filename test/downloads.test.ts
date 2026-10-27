import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import type { JobContext } from "../src/server/core/jobs.js";
import type { GrabRecord } from "../src/server/integrations/arr.js";
import type { Torrent, TorrentFile } from "../src/server/integrations/qbittorrent.js";
import { blockedFiles, DEFAULT_BLOCKED, runCheck } from "../src/tools/downloads/check.js";
import type { DownloadsMode } from "../src/tools/downloads/shared.js";
import { DownloadsStore, migrations } from "../src/tools/downloads/store.js";
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

const file = (name: string, priority = 1): TorrentFile => ({ name, size: 1e9, priority });

const FAKE: Torrent = {
  hash: "f254d6c6aa",
  name: "NCIS S24E04 Like Subscribe 1080p WEB H264-FLUX",
  category: "sonarr",
  state: "uploading",
  size: 1.1e9,
  contentPath: "/plex/temp/NCIS S24E04 Like Subscribe 1080p WEB H264-FLUX",
};
const REAL: Torrent = { ...FAKE, hash: "aa11", name: "NCIS.S20.1080p.AMZN.WEB-DL" };
const MINE: Torrent = { ...FAKE, hash: "bb22", name: "Some installer", category: "" };

function setup(mode: DownloadsMode, options: { markFailedError?: Error; noGrab?: boolean } = {}) {
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
      torrents: async () => [FAKE, REAL, MINE],
      files: async (hash: string) => files[hash] ?? [],
      deleteWithFiles: async (hashes: string[]) => void calls.push(`delete ${hashes.join()}`),
    },
    arrs: [
      {
        app: "sonarr" as const,
        name: "Sonarr",
        configured: () => true,
        grabOf: async (hash: string) => (hash === FAKE.hash && !options.noGrab ? grab : null),
        markFailed: async (id: number) => {
          if (options.markFailedError) throw options.markFailedError;
          calls.push(`markFailed ${id}`);
        },
      },
    ],
    mode,
    categories: ["sonarr", "radarr"],
    extensions: DEFAULT_BLOCKED,
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
    expect(result).toEqual({ torrents: 2, fakes: 1, removed: 0, failed: 0 });
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
