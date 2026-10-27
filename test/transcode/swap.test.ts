import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../../src/server/core/db.js";
import { EventBus } from "../../src/server/core/events.js";
import { JobCancelledError, type JobContext } from "../../src/server/core/jobs.js";
import { Lock } from "../../src/server/core/lock.js";
import { encodingSettings } from "../../src/server/core/schedule.js";
import { SettingsStore } from "../../src/server/core/settings.js";
import type { Integrations } from "../../src/server/core/tools.js";
import { runScan } from "../../src/tools/transcode/scan.js";
import { transcodeSettings } from "../../src/tools/transcode/server.js";
import type { EncodeDetails } from "../../src/tools/transcode/shared.js";
import { LibraryStore, migrations } from "../../src/tools/transcode/store.js";
import {
  runSwap,
  type SwapPayload,
  swapPathsFor,
  tempFileId,
} from "../../src/tools/transcode/swap.js";
import { tempDir } from "../helpers.js";

const ORIGINAL = "original video bytes ".repeat(50);
const RESULT = "smaller result";

function fakeJob(
  fileId: number,
  options: { cancelOnCopy?: boolean } = {},
): JobContext<SwapPayload> & { logs: string[] } {
  const logs: string[] = [];
  const controller = new AbortController();
  return {
    id: 1,
    payload: { fileId, name: "test" },
    signal: controller.signal,
    logs,
    progress: () => {},
    log: (message) => void logs.push(message),
    checkpoint: async () => {
      if (options.cancelOnCopy) {
        controller.abort("cancel");
        throw new JobCancelledError();
      }
    },
    run: () => Promise.reject(new Error("no processes in swap tests")),
  };
}

/** A library with one approved result for `name`, ready to swap. */
function setup(name = "Show - S01E01.mkv") {
  const library = tempDir("kondo-lib-");
  const workRoot = tempDir("kondo-work-");
  const folder = path.join(library, "Show", "Season 01");
  mkdirSync(folder, { recursive: true });
  const source = path.join(folder, name);
  writeFileSync(source, ORIGINAL, { mode: 0o666 });

  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  migrate(db, "tool:transcode", migrations);
  const store = new LibraryStore(db);
  const s = statSync(source);
  store.reconcile(
    new Map([[source, { root: library, size: s.size, mtimeMs: Math.round(s.mtimeMs) }]]),
    new Date().toISOString(),
    true,
  );
  const id = store.needingProbe()[0]?.id ?? 0;
  const workDir = path.join(workRoot, String(id));
  mkdirSync(workDir);
  const output = path.join(workDir, "output.mkv");
  writeFileSync(output, RESULT);
  store.saveOutcome(id, {
    status: "approved",
    encoder: "hevc_nvenc",
    outputPath: output,
    outputBytes: RESULT.length,
    details: { sourceBytes: ORIGINAL.length, outputBytes: RESULT.length } as EncodeDetails,
  });

  const rescans: string[] = [];
  const deps = {
    store,
    workRoot,
    lock: new Lock(),
    isPlaying: () => false,
    rescan: async (_file: unknown, dir: string) => {
      rescans.push(dir);
      return ["rescanned"];
    },
  };
  return { library, folder, source, id, workDir, output, store, deps, rescans, db };
}

describe("swapping a result into the library", () => {
  it("replaces a same-named file in place and keeps a torrent's hardlink intact", async () => {
    const t = setup();
    const torrent = path.join(t.library, "torrent.mkv");
    linkSync(t.source, torrent);

    const result = await runSwap(fakeJob(t.id), t.deps);

    expect(result).toEqual({ status: "done", savedBytes: ORIGINAL.length - RESULT.length });
    expect(readFileSync(t.source, "utf8")).toBe(RESULT);
    expect(readFileSync(torrent, "utf8")).toBe(ORIGINAL);
    expect(statSync(t.source).mode & 0o777).toBe(statSync(torrent).mode & 0o777);
    expect(readdirSync(t.folder)).toEqual(["Show - S01E01.mkv"]);
    // The result is gone from the work folder; its frames stay for "Recently replaced".
    expect(existsSync(t.output)).toBe(false);
    expect(t.store.outcome(t.id)?.status).toBe("done");
    expect(t.rescans).toEqual([t.folder]);
    expect(t.store.logEntries({ limit: 10 })).toMatchObject([
      {
        kind: "replaced",
        path: t.source,
        sourceBytes: ORIGINAL.length,
        outputBytes: RESULT.length,
      },
    ]);
    expect(t.store.history(10)).toMatchObject([
      { fileId: t.id, path: t.source, sourceBytes: ORIGINAL.length, outputBytes: RESULT.length },
    ]);

    // The row follows the new file, so the next scan reads it afresh instead of forgetting it.
    expect(t.store.sourceState(t.id)?.size).toBe(RESULT.length);
    expect(t.store.needingProbe().map((f) => f.id)).toEqual([t.id]);
    expect(t.store.summary([t.library]).done).toEqual({
      count: 1,
      savedBytes: ORIGINAL.length - RESULT.length,
    });
  });

  it("swaps an .mp4 for an .mkv and removes the old file", async () => {
    const t = setup("Show - S01E01.mp4");
    await runSwap(fakeJob(t.id), t.deps);
    expect(readdirSync(t.folder)).toEqual(["Show - S01E01.mkv"]);
    expect(t.store.detail(t.id)?.path).toBe("Show/Season 01/Show - S01E01.mkv");
  });

  it("waits while someone is watching the file", async () => {
    const t = setup();
    const result = await runSwap(fakeJob(t.id), { ...t.deps, isPlaying: () => true });
    expect(result.status).toBe("waiting");
    expect(readFileSync(t.source, "utf8")).toBe(ORIGINAL);
    expect(readdirSync(t.folder)).toHaveLength(1);
    expect(t.store.outcome(t.id)?.status).toBe("approved");
  });

  it("throws the result away if the original changed since it was encoded", async () => {
    const t = setup();
    writeFileSync(t.source, "an upgraded release");
    const result = await runSwap(fakeJob(t.id), t.deps);
    expect(result.status).toBe("stale");
    expect(readFileSync(t.source, "utf8")).toBe("an upgraded release");
    expect(t.store.outcome(t.id)).toBeNull();
    expect(existsSync(t.workDir)).toBe(false);
  });

  it("refuses to overwrite a different file that already has the new name", async () => {
    const t = setup("Show - S01E01.mp4");
    writeFileSync(path.join(t.folder, "Show - S01E01.mkv"), "someone else's file");
    await expect(runSwap(fakeJob(t.id), t.deps)).rejects.toThrow(/already exists/);
    expect(readFileSync(path.join(t.folder, "Show - S01E01.mkv"), "utf8")).toBe(
      "someone else's file",
    );
    const outcome = t.store.outcome(t.id);
    expect(outcome?.status).toBe("awaiting-approval");
    expect(outcome?.error).toMatch(/already exists/);
    expect(t.store.logEntries({ limit: 10 })).toMatchObject([
      { kind: "swap-failed", detail: expect.stringMatching(/already exists/) },
    ]);
  });

  it("cleans up and asks again when cancelled while copying", async () => {
    const t = setup();
    await expect(runSwap(fakeJob(t.id, { cancelOnCopy: true }), t.deps)).rejects.toThrow(
      JobCancelledError,
    );
    expect(readdirSync(t.folder)).toEqual(["Show - S01E01.mkv"]);
    expect(readFileSync(t.source, "utf8")).toBe(ORIGINAL);
    expect(t.store.outcome(t.id)?.status).toBe("awaiting-approval");
  });

  it("finishes a swap that a crash cut short before the rename", async () => {
    const t = setup();
    const paths = swapPathsFor(t.source, t.id);
    writeFileSync(paths.temp, RESULT);
    t.store.startSwap(t.id, paths);

    // Plex can't veto finishing: the library is already part-changed.
    const result = await runSwap(fakeJob(t.id), { ...t.deps, isPlaying: () => true });
    expect(result.status).toBe("done");
    expect(readFileSync(t.source, "utf8")).toBe(RESULT);
    expect(readdirSync(t.folder)).toEqual(["Show - S01E01.mkv"]);
  });

  it("finishes a swap that a crash cut short after the rename", async () => {
    const t = setup("Show - S01E01.mp4");
    const paths = swapPathsFor(t.source, t.id);
    t.store.startSwap(t.id, paths);
    writeFileSync(paths.final, RESULT); // renamed, but the old .mp4 is still there

    const job = fakeJob(t.id);
    expect((await runSwap(job, t.deps)).status).toBe("done");
    expect(readdirSync(t.folder)).toEqual(["Show - S01E01.mkv"]);
    expect(job.logs).toContain("Finishing a swap that was cut short");
  });

  it("goes back to approved if a cut-short swap's copy has vanished", async () => {
    const t = setup();
    t.store.startSwap(t.id, swapPathsFor(t.source, t.id));
    await expect(runSwap(fakeJob(t.id), t.deps)).rejects.toThrow(/went missing/);
    expect(readFileSync(t.source, "utf8")).toBe(ORIGINAL);
    expect(t.store.outcome(t.id)?.status).toBe("approved");
  });

  it("does nothing for a result that isn't approved", async () => {
    const t = setup();
    t.store.setOutcomeStatus(t.id, "awaiting-approval");
    expect((await runSwap(fakeJob(t.id), t.deps)).status).toBe("skipped");
    expect(readFileSync(t.source, "utf8")).toBe(ORIGINAL);
  });
});

describe("temp files", () => {
  it("names them hidden, next to the original, with the file id", () => {
    expect(swapPathsFor("/tv/Show/Ep.mp4", 12)).toEqual({
      source: "/tv/Show/Ep.mp4",
      temp: "/tv/Show/.Ep.kondo-12.mkv",
      final: "/tv/Show/Ep.mkv",
    });
    expect(tempFileId(".Ep.kondo-12.mkv")).toBe(12);
    expect(tempFileId("Ep.kondo-12.mkv")).toBeNull();
    expect(tempFileId(".Ep.mkv")).toBeNull();
  });

  it("are removed by a scan unless a swap is part-way through", async () => {
    const t = setup();
    const settings = new SettingsStore(t.db, new EventBus());
    settings.register(encodingSettings);
    settings.register(transcodeSettings);
    settings.update("transcode", { roots: t.library });
    const stray = path.join(t.folder, ".Old.kondo-999.mkv");
    writeFileSync(stray, "partial");
    const inProgress = swapPathsFor(t.source, t.id).temp;
    writeFileSync(inProgress, RESULT);
    t.store.startSwap(t.id, swapPathsFor(t.source, t.id));

    const job = { ...fakeJob(t.id), payload: {} } as JobContext<unknown>;
    const integrations = {
      sonarr: { configured: () => false, app: "sonarr", name: "Sonarr" },
      radarr: { configured: () => false, app: "radarr", name: "Radarr" },
    } as unknown as Integrations;
    await runScan(job, { store: t.store, settings, integrations });

    expect(existsSync(stray)).toBe(false);
    expect(existsSync(inProgress)).toBe(true);
  });
});

describe("lock", () => {
  it("runs holders one at a time, in order", async () => {
    const lock = new Lock();
    const order: string[] = [];
    let release!: () => void;
    const first = lock.run(async () => {
      order.push("first start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first end");
    });
    const second = lock.run(async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  it("stops waiting when cancelled", async () => {
    const lock = new Lock();
    let release!: () => void;
    const held = lock.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const waiting = lock.run(async () => "ran", controller.signal);
    controller.abort("cancel");
    await expect(waiting).rejects.toThrow(JobCancelledError);
    release();
    await held;
    expect(await lock.run(async () => "free again")).toBe("free again");
  });
});
