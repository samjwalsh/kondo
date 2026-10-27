// Puts an approved result into the library in place of the original. Every step is recorded
// before it happens so a crash part-way is finished (or undone) on the next start.

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { JobCancelledError, type JobContext } from "../../server/core/jobs.js";
import type { Lock } from "../../server/core/lock.js";
import { errorMessage } from "../../server/integrations/http.js";
import { workDirFor } from "./encode.js";
import type { FileDetail } from "./shared.js";
import type { LibraryStore, SwapPaths } from "./store.js";

export interface SwapPayload {
  fileId: number;
  name: string;
}

export interface SwapResult {
  status: "done" | "waiting" | "skipped" | "stale";
  savedBytes?: number;
}

export interface SwapDeps {
  store: LibraryStore;
  workRoot: string;
  /** Held while the library is being changed, so a scan never sees a swap half-done. */
  lock: Lock;
  /** True if someone is watching (or paused on) the file, or Plex can't be asked. */
  isPlaying: (file: string) => boolean;
  /** Tells Plex and Sonarr/Radarr to look again; returns lines for the job log. */
  rescan: (file: FileDetail, folder: string) => Promise<string[]>;
  onFinished?: () => void;
}

/** `Show S01E01.mp4` → `.Show S01E01.kondo-12.mkv`, next to the original. */
export function swapPathsFor(source: string, fileId: number): SwapPaths {
  const dir = path.dirname(source);
  const stem = path.basename(source, path.extname(source));
  return {
    source,
    temp: path.join(dir, `.${stem}.kondo-${fileId}.mkv`),
    final: path.join(dir, `${stem}.mkv`),
  };
}

/** The file id of one of Kondo's temp files, or null for any other name. */
export function tempFileId(name: string): number | null {
  const match = /^\..+\.kondo-(\d+)\.mkv$/.exec(name);
  return match ? Number(match[1]) : null;
}

const sizeOf = (file: string) =>
  stat(file).then(
    (s) => s.size,
    () => null,
  );

function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;
}

async function copyFile(
  job: JobContext<SwapPayload>,
  from: string,
  to: string,
  total: number,
): Promise<void> {
  let copied = 0;
  const started = Date.now();
  await pipeline(
    createReadStream(from, { highWaterMark: 4 << 20 }),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        await job.checkpoint();
        copied += chunk.length;
        const mbps = copied / 1e6 / Math.max(0.001, (Date.now() - started) / 1000);
        job.progress(copied / total, `Copying into the library · ${mbps.toFixed(0)} MB/s`);
        yield chunk;
      }
    },
    createWriteStream(to, { flags: "wx" }),
    { signal: job.signal },
  );
  // Make sure it's on disk before the original is replaced. Some network filesystems
  // can't fsync; the size check that follows still applies.
  const handle = await open(to, "r+");
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
}

export async function runSwap(job: JobContext<SwapPayload>, deps: SwapDeps): Promise<SwapResult> {
  const { fileId } = job.payload;
  try {
    return await deps.lock.run(async () => {
      const outcome = deps.store.outcome(fileId);
      const file = deps.store.detail(fileId);
      if (!outcome || !file) {
        job.log("Nothing to swap in any more");
        return { status: "skipped" };
      }
      if (outcome.status === "swapping") return finish(job, deps, file);
      if (outcome.status !== "approved") {
        job.log(`Nothing to do: this result is "${outcome.status}", not approved`);
        return { status: "skipped" };
      }
      return start(job, deps, file);
    }, job.signal);
  } finally {
    deps.onFinished?.();
  }
}

async function start(
  job: JobContext<SwapPayload>,
  deps: SwapDeps,
  file: FileDetail,
): Promise<SwapResult> {
  const { store } = deps;
  const fileId = file.id;
  const source = path.join(file.root, file.path);
  const output = store.outputPath(fileId);
  const expected = file.outcome?.outputBytes ?? null;
  const paths = swapPathsFor(source, fileId);

  try {
    // The original must be exactly what was encoded.
    const recorded = store.sourceState(fileId);
    const current = await stat(source).catch(() => null);
    if (
      !current ||
      !recorded ||
      current.size !== recorded.size ||
      Math.round(current.mtimeMs) !== recorded.mtimeMs
    ) {
      job.log(
        current
          ? "The original changed since it was encoded, so this result is thrown away; the next scan looks at it again"
          : "The original is gone, so this result is thrown away",
        "warn",
      );
      store.forgetOutcome(fileId);
      await rm(workDirFor(deps.workRoot, fileId), { recursive: true, force: true });
      return { status: "stale" };
    }
    if (!output || expected === null || (await sizeOf(output)) !== expected) {
      throw new Error("The encoded result is missing or the wrong size");
    }
    if (paths.final !== source && (await sizeOf(paths.final)) !== null) {
      throw new Error(`${path.basename(paths.final)} already exists next to the original`);
    }
    if (deps.isPlaying(source)) {
      job.log("Someone is watching this (or Plex can't be asked); trying again later");
      return { status: "waiting" };
    }

    // 1. Copy next to the original under a hidden name, and check it arrived whole.
    await rm(paths.temp, { force: true });
    job.log(`Copying ${formatBytes(expected)} next to the original`);
    await copyFile(job, output, paths.temp, expected);
    const copied = await sizeOf(paths.temp);
    if (copied !== expected) {
      throw new Error(`The copy is ${copied ?? 0} bytes; expected ${expected}`);
    }
    await chmod(paths.temp, current.mode & 0o777);

    // Someone may have pressed play while it copied.
    if (deps.isPlaying(source)) {
      await rm(paths.temp, { force: true });
      job.log("Someone started watching this while it copied; trying again later");
      return { status: "waiting" };
    }

    // 2. From here on the swap is recorded first, so a crash can be finished on restart.
    store.startSwap(fileId, paths);
  } catch (error) {
    await rm(paths.temp, { force: true }).catch(() => {});
    // Cancelled (the copy stops with an AbortError) or Kondo stopping: the library is unchanged.
    if (error instanceof JobCancelledError || job.signal.aborted) {
      if (job.signal.reason === "cancel") {
        store.setOutcomeStatus(
          fileId,
          "awaiting-approval",
          "Swap cancelled; approve it again to retry",
        );
      }
      throw new JobCancelledError();
    } else {
      store.setOutcomeStatus(
        fileId,
        "awaiting-approval",
        `Couldn't swap it in: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
  return finish(job, deps, file);
}

/** Replaces the original. Also picks up a swap cut short by a crash, from whatever is on disk. */
async function finish(
  job: JobContext<SwapPayload>,
  deps: SwapDeps,
  file: FileDetail,
): Promise<SwapResult> {
  const { store } = deps;
  const fileId = file.id;
  const paths = store.swapPaths(fileId);
  const expected = file.outcome?.outputBytes ?? null;
  if (!paths || expected === null) {
    store.setOutcomeStatus(
      fileId,
      "awaiting-approval",
      "The swap's record was incomplete; approve it again to retry",
    );
    throw new Error("The swap's record is incomplete");
  }

  const tempSize = await sizeOf(paths.temp);
  if (tempSize !== null) {
    if (tempSize !== expected) {
      await rm(paths.temp, { force: true });
      store.setOutcomeStatus(fileId, "approved", null);
      throw new Error("The copy in the library was the wrong size; it will be copied again");
    }
    // 3. Atomic: with the same name, the episode is never missing, even for an instant.
    try {
      await rename(paths.temp, paths.final);
    } catch (error) {
      await rm(paths.temp, { force: true }).catch(() => {});
      store.setOutcomeStatus(
        fileId,
        "awaiting-approval",
        `Couldn't swap it in: ${errorMessage(error)}`,
      );
      throw error;
    }
  } else if ((await sizeOf(paths.final)) !== expected) {
    // No temp file and no new file: the library was never changed.
    store.setOutcomeStatus(fileId, "approved", null);
    throw new Error("The copy in the library went missing; it will be copied again");
  } else {
    job.log("Finishing a swap that was cut short");
  }

  // 4. A new name (e.g. .mp4 → .mkv): the old file goes.
  if (paths.source !== paths.final) await rm(paths.source, { force: true });

  // 5. Record it, tidy up, and tell Plex and Sonarr/Radarr.
  const now = await stat(paths.final);
  const sourceBytes = file.outcome?.details?.sourceBytes ?? file.sizeBytes;
  store.completeSwap(fileId, {
    path: paths.final,
    size: now.size,
    mtimeMs: now.mtimeMs,
    sourceBytes,
    encoder: file.outcome?.encoder ?? null,
    details: file.outcome?.details ?? null,
  });
  // The comparison frames stay a while for "Recently replaced"; the old work folders are swept.
  await rm(path.join(workDirFor(deps.workRoot, fileId), "output.mkv"), { force: true });
  job.log(
    `Swapped in: ${formatBytes(sourceBytes)} → ${formatBytes(now.size)}, ${formatBytes(sourceBytes - now.size)} saved`,
  );
  try {
    for (const line of await deps.rescan(file, path.dirname(paths.final))) job.log(line);
  } catch (error) {
    job.log(`Couldn't ask for a rescan: ${errorMessage(error)}`, "warn");
  }
  return { status: "done", savedBytes: sourceBytes - now.size };
}
