import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../../src/server/core/db.js";
import { EventBus } from "../../src/server/core/events.js";
import type { JobContext } from "../../src/server/core/jobs.js";
import { runProcess } from "../../src/server/core/process.js";
import { encodingSettings } from "../../src/server/core/schedule.js";
import { SettingsStore } from "../../src/server/core/settings.js";
import type { Integrations } from "../../src/server/core/tools.js";
import { runScan } from "../../src/tools/transcode/scan.js";
import { transcodeSettings } from "../../src/tools/transcode/server.js";
import { LibraryStore, migrations } from "../../src/tools/transcode/store.js";
import { tempDir } from "../helpers.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { stdio: "pipe" })
      .toString()
      .includes("libx264");
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A 1-second test video with English + French audio and an English subtitle. */
function makeVideo(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const srt = `${file}.srt`;
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=25:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:duration=1",
    "-i",
    srt,
    "-map",
    "0",
    "-map",
    "1",
    "-map",
    "2",
    "-map",
    "3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-b:v",
    "3M",
    "-c:a",
    "aac",
    "-c:s",
    "srt",
    "-metadata:s:a:0",
    "language=eng",
    "-metadata:s:a:1",
    "language=fre",
    "-metadata:s:s:0",
    "language=eng",
    file,
  ]);
  rmSync(srt);
}

function fakeJob(): JobContext<unknown> & { logs: string[] } {
  const logs: string[] = [];
  return {
    id: 1,
    payload: {},
    signal: new AbortController().signal,
    logs,
    progress: () => {},
    log: (message) => void logs.push(message),
    checkpoint: async () => {},
    run: (command, args, options) => runProcess(command, args, options),
  };
}

const noArr = { configured: () => false } as const;
const integrations = {
  sonarr: { ...noArr, app: "sonarr", name: "Sonarr" },
  radarr: { ...noArr, app: "radarr", name: "Radarr" },
} as unknown as Integrations;

describe.skipIf(!hasFfmpeg)("library scan (needs ffmpeg)", () => {
  it("finds, reads and decides files, respects 'never touch', and forgets deleted files", async () => {
    const library = tempDir("kondo-lib-");
    const tv = path.join(library, "TV");
    const temp = path.join(tv, "temp");
    makeVideo(path.join(tv, "Show A", "Season 01", "Show A - S01E01.mkv"));
    makeVideo(path.join(tv, "Show A", "Season 01", "Show A - S01E02.mkv"));
    makeVideo(path.join(temp, "Some.Torrent", "file.mkv"));
    writeFileSync(path.join(tv, "Show A", ".hidden.kondo-1.mkv"), "partial");
    writeFileSync(path.join(tv, "Show A", "notes.txt"), "not a video");

    const db = openDb(tempDir());
    migrate(db, "core", coreMigrations);
    migrate(db, "tool:transcode", migrations);
    const settings = new SettingsStore(db, new EventBus());
    settings.register(encodingSettings);
    settings.register(transcodeSettings);
    settings.update("transcode", { roots: tv, neverTouch: temp });
    const store = new LibraryStore(db);

    const first = await runScan(fakeJob(), { store, settings, integrations });
    expect(first).toMatchObject({ files: 2, read: 2, unreadable: 0 });

    const page = store.page({ filter: "all", sort: "path", limit: 10, offset: 0 });
    expect(page.files.map((f) => f.path)).toEqual([
      "Show A/Season 01/Show A - S01E01.mkv",
      "Show A/Season 01/Show A - S01E02.mkv",
    ]);
    const detail = store.detail(page.files[0]?.id ?? 0);
    expect(detail?.info?.audio.map((a) => a.language)).toEqual(["eng", "fre"]);
    expect(detail?.decision).not.toBeNull();

    rmSync(path.join(tv, "Show A", "Season 01", "Show A - S01E02.mkv"));
    const second = await runScan(fakeJob(), { store, settings, integrations });
    expect(second).toMatchObject({ files: 1, read: 0 });
    expect(store.summary([tv]).files).toBe(1);
  }, 30_000);

  it("refuses to scan when a library folder is missing (unmounted share)", async () => {
    const db = openDb(tempDir());
    migrate(db, "core", coreMigrations);
    migrate(db, "tool:transcode", migrations);
    const settings = new SettingsStore(db, new EventBus());
    settings.register(encodingSettings);
    settings.register(transcodeSettings);
    settings.update("transcode", { roots: "/nonexistent/TV" });
    await expect(
      runScan(fakeJob(), { store: new LibraryStore(db), settings, integrations }),
    ).rejects.toThrow(/Is the media share mounted/);
  });
});
