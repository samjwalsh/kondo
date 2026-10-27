import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../../src/server/core/db.js";
import { EventBus } from "../../src/server/core/events.js";
import type { JobContext } from "../../src/server/core/jobs.js";
import { Lock } from "../../src/server/core/lock.js";
import { encodingSettings } from "../../src/server/core/schedule.js";
import { SettingsStore } from "../../src/server/core/settings.js";
import { squishOverride } from "../../src/tools/transcode/rules.js";
import { transcodeSettings } from "../../src/tools/transcode/server.js";
import type { ArrMatch, MediaInfo } from "../../src/tools/transcode/shared.js";
import {
  runSquishCheck,
  runSquishRename,
  type SquishRenamePayload,
  squishTarget,
  titleOf,
} from "../../src/tools/transcode/squish.js";
import { LibraryStore, migrations } from "../../src/tools/transcode/store.js";
import { tempDir } from "../helpers.js";

function fakeJob<P>(payload: P): JobContext<P> & { logs: string[] } {
  const logs: string[] = [];
  return {
    id: 1,
    payload,
    signal: new AbortController().signal,
    logs,
    progress: () => {},
    log: (message) => void logs.push(message),
    checkpoint: async () => {},
    run: () => Promise.reject(new Error("no processes here")),
  };
}

function touch(file: string, contents = "x"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

const NCIS: ArrMatch = { app: "sonarr", id: 7, title: "NCIS", originalLanguage: "eng" };

function setup() {
  const library = tempDir("kondo-lib-");
  const tv = path.join(library, "TV");
  const season = path.join(tv, "NCIS", "Season 1");
  touch(path.join(season, "NCIS S01E01 [SQUISH].mkv"), "squished video");
  touch(path.join(season, "NCIS S01E01 [SQUISH].en.srt"));
  // Bazarr's subtitle for the old name is still there: this one's name is taken.
  touch(path.join(season, "NCIS S01E02 [SQUISH].en.srt"));
  touch(path.join(season, "NCIS S01E02.en.srt"));
  touch(path.join(tv, "Other Show", "Other Show S01E01 [SQUISH].mkv"));
  touch(path.join(tv, "temp", "Some Torrent [SQUISH].mkv")); // never touched
  touch(path.join(season, ".hidden [SQUISH].mkv"));

  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  migrate(db, "tool:transcode", migrations);
  const settings = new SettingsStore(db, new EventBus());
  settings.register(encodingSettings);
  settings.register(transcodeSettings);
  settings.update("transcode", { roots: tv, neverTouch: path.join(tv, "temp") });
  const store = new LibraryStore(db);

  // Kondo's scan knows the video: H.265, matched to Sonarr.
  const video = path.join(season, "NCIS S01E01 [SQUISH].mkv");
  store.reconcile(
    new Map([[video, { root: tv, size: 14, mtimeMs: 1 }]]),
    new Date().toISOString(),
    true,
  );
  db.prepare(
    "UPDATE transcode_files SET video_codec = 'hevc', probed_at = 'then', arr = ? WHERE path = ?",
  ).run(JSON.stringify(NCIS), video);

  const rescans: { arr: ArrMatch | null; folder: string }[] = [];
  let watching: string | null = null;
  const deps = {
    store,
    settings,
    lock: new Lock(),
    isPlaying: (file: string) => file === watching,
    rescan: async (arr: ArrMatch | null, folder: string) => {
      rescans.push({ arr, folder });
      return [];
    },
  };
  return {
    tv,
    season,
    video,
    store,
    deps,
    rescans,
    watch: (file: string | null) => {
      watching = file;
    },
  };
}

describe("[SQUISH] names", () => {
  it("strips the tag and groups files by series/movie folder", () => {
    expect(squishTarget("Ep [SQUISH].en.srt")).toBe("Ep.en.srt");
    expect(squishTarget("Ep.mkv")).toBeNull();
    expect(titleOf("/tv/NCIS/Season 1/Ep.mkv", "/tv")).toBe("/tv/NCIS");
    expect(titleOf("/movies/Film.mkv", "/movies")).toBe("/movies");
  });

  it("counts only H.265 files as Squish's work (it renamed a few it never encoded)", () => {
    const hevc = { video: { codec: "hevc" } } as MediaInfo;
    const h264 = { video: { codec: "h264" } } as MediaInfo;
    expect(squishOverride("/tv/Show/Ep [SQUISH].mkv", hevc)?.reasonCode).toBe("squish-done");
    expect(squishOverride("/tv/Show/Ep [SQUISH].m4v", h264)).toBeNull();
    expect(squishOverride("/tv/Show/Ep.mkv", hevc)).toBeNull();
  });

  it("lists what would be renamed, and clashes, without touching anything", async () => {
    const t = setup();
    const result = await runSquishCheck(fakeJob({}), t.deps);
    expect(result).toEqual({ files: 4, clashes: 1, titles: 2 });
    const summary = t.store.squishSummary();
    expect(summary.titles.map((x) => [x.name, x.pending, x.clashes])).toEqual([
      ["NCIS", 2, 1],
      ["Other Show", 1, 0],
    ]);
    expect(readdirSync(t.season)).toContain("NCIS S01E01 [SQUISH].mkv");
  });

  it("renames one title, keeps Kondo's record of the video, and asks for rescans", async () => {
    const t = setup();
    await runSquishCheck(fakeJob({}), t.deps);
    const ncis = path.join(t.tv, "NCIS");
    const result = await runSquishRename(fakeJob<SquishRenamePayload>({ title: ncis }), t.deps);

    expect(result).toEqual({ renamed: 2, clashes: 0, failed: 0, watched: 0 });
    expect(readdirSync(t.season).sort()).toEqual([
      ".hidden [SQUISH].mkv",
      "NCIS S01E01.en.srt",
      "NCIS S01E01.mkv",
      "NCIS S01E02 [SQUISH].en.srt",
      "NCIS S01E02.en.srt",
    ]);
    // The other title is untouched until asked.
    expect(readdirSync(path.join(t.tv, "Other Show"))).toEqual(["Other Show S01E01 [SQUISH].mkv"]);
    expect(t.rescans).toEqual([{ arr: NCIS, folder: ncis }]);

    const file = t.store.page({ filter: "all", sort: "path", limit: 10, offset: 0 }).files[0];
    expect(file?.path).toBe("NCIS/Season 1/NCIS S01E01.mkv");
    expect(file?.outcomeStatus).toBe("squish");
    expect(t.store.needingProbe()).toEqual([]); // not read again
    expect(t.store.squishSummary()).toMatchObject({ pending: 1, clashes: 1, done: 2 });
  });

  it("leaves a title for later while someone is watching it", async () => {
    const t = setup();
    await runSquishCheck(fakeJob({}), t.deps);
    t.watch(t.video);
    const result = await runSquishRename(fakeJob<SquishRenamePayload>({}), t.deps);
    expect(result).toEqual({ renamed: 1, clashes: 0, failed: 0, watched: 1 });
    expect(readdirSync(t.season)).toContain("NCIS S01E01 [SQUISH].mkv");
  });
});
