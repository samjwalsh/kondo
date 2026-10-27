import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Lock } from "../../server/core/lock.js";
import { sendFile } from "../../server/core/sendFile.js";
import { defineTool, type Integrations } from "../../server/core/tools.js";
import { errorMessage } from "../../server/integrations/http.js";
import type { SettingsSection } from "../../shared/settings.js";
import { CALIBRATION_KEY, runCalibration } from "./calibrate.js";
import { type EncodePayload, type EncodeResult, runEncode, workDirFor } from "./encode.js";
import { librarySettings, runScan } from "./scan.js";
import type { ArrMatch, Calibration, FileFilter, FileSort } from "./shared.js";
import {
  runSquishCheck,
  runSquishRename,
  type SquishCheckResult,
  type SquishDeps,
  type SquishRenamePayload,
  type SquishRenameResult,
} from "./squish.js";
import { encodeKey, LibraryStore, migrations, swapKey } from "./store.js";
import { morningSummary } from "./summary.js";
import { runSwap, type SwapPayload, type SwapResult } from "./swap.js";

export const transcodeSettings: SettingsSection = {
  scope: "transcode",
  title: "Transcode",
  group: "tool",
  description: "Which files Kondo looks at, and when an H.265 file is still worth re-encoding.",
  fields: [
    {
      key: "roots",
      label: "Library folders",
      type: "lines",
      default: "",
      placeholder: "/mnt/media/TV\n/mnt/media/Movies",
      help: "One per line. Kondo never looks outside these folders.",
    },
    {
      key: "neverTouch",
      label: "Never touch",
      type: "lines",
      default: "",
      help: "Folders inside the library to leave completely alone, e.g. where torrents download.",
    },
    {
      key: "threshold1080Mbps",
      label: "Re-encode 1080p H.265 above (Mb/s)",
      type: "number",
      default: 4.5,
      min: 0.5,
      max: 50,
      step: 0.1,
      help: "Files already in H.265, AV1 or VP9 are left alone unless their video is bigger than this.",
    },
    {
      key: "threshold720Mbps",
      label: "Re-encode 720p H.265 above (Mb/s)",
      type: "number",
      default: 1.6,
      min: 0.2,
      max: 30,
      step: 0.1,
    },
    {
      key: "thresholdSdMbps",
      label: "Re-encode SD H.265 above (Mb/s)",
      type: "number",
      default: 0.8,
      min: 0.1,
      max: 20,
      step: 0.1,
    },
    {
      key: "scanEveryMinutes",
      label: "Look for new files every (minutes)",
      type: "number",
      default: 60,
      min: 10,
      max: 1440,
    },
    {
      key: "mode",
      label: "Encoding",
      type: "select",
      default: "off",
      options: [
        { value: "off", label: "Off: only show what Kondo would do" },
        { value: "approval", label: "On: encode, then wait for my approval" },
        { value: "auto", label: "Automatic: encode and swap in results that pass every check" },
      ],
      help: "Encodes run in the night window (and idle mode). With approval, results wait in Kondo's own folder until you approve them. Automatic also approves anything already waiting.",
    },
    {
      key: "morningSummary",
      label: "Send a short summary on Telegram when the night window ends",
      type: "boolean",
      default: true,
      help: "A few lines: files replaced, space saved, anything that failed. Also sent after a quiet night, so you know Kondo is running.",
    },
    {
      key: "maxSwapsPerDay",
      label: "In automatic mode, swap in at most this many a day",
      type: "number",
      default: 0,
      min: 0,
      max: 1000,
      help: "0 means no limit. Over the limit, results wait for approval until the next day.",
    },
    {
      key: "maxWaiting",
      label: "Encode at most this many ahead of approval",
      type: "number",
      default: 10,
      min: 1,
      max: 100,
      help: "Counts finished results waiting for you plus encodes queued or running.",
    },
    {
      key: "minSavingsPercent",
      label: "Keep a result only if it's at least this much smaller (%)",
      type: "number",
      default: 20,
      min: 1,
      max: 90,
    },
  ],
};

/** How many recent swaps keep their comparison frames. */
const RECENT_KEPT = 50;

const FILTERS = new Set<FileFilter>(["transcode", "skip", "error", "all"]);
const SORTS = new Set<FileSort>(["saving", "size", "path"]);

/** Tells Plex (one folder) and Sonarr/Radarr (one series/movie) to look again. Best effort. */
async function rescan(
  integrations: Integrations,
  arr: ArrMatch | null,
  folder: string,
): Promise<string[]> {
  const lines: string[] = [];
  if (integrations.plex.configured()) {
    try {
      const library = await integrations.plex.refreshFolder(folder);
      lines.push(
        library
          ? `Asked Plex to rescan the folder (${library})`
          : "No Plex library contains this folder, so Plex wasn't asked to rescan",
      );
    } catch (error) {
      lines.push(`Couldn't ask Plex to rescan: ${errorMessage(error)}`);
    }
  }
  if (arr) {
    const client = integrations[arr.app];
    if (client.configured()) {
      try {
        await client.rescan(arr.id);
        lines.push(`Asked ${client.name} to rescan ${arr.title}`);
      } catch (error) {
        lines.push(`Couldn't ask ${client.name} to rescan: ${errorMessage(error)}`);
      }
    }
  }
  return lines;
}

const localDate = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
const localClock = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
const minutesOfDay = (clock: string) => {
  const [h = 0, m = 0] = clock.split(":").map(Number);
  return h * 60 + m;
};

function terabytes(bytes: number): string {
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${Math.round(bytes / 1e9)} GB`;
}

export default defineTool({
  id: "transcode",
  name: "Transcode",
  description: "Shrinks the library to H.265, keeping the audio and subtitle tracks people use.",
  settings: [transcodeSettings],
  migrations,

  register(ctx) {
    const store = new LibraryStore(ctx.db);
    const workRoot = path.join(ctx.dataDir, "work");
    const scan = () => ctx.enqueue("scan", {}, { dedupeKey: "transcode:scan" });
    // Scans and swaps take turns, so a scan never sees a file half-swapped.
    const libraryLock = new Lock();

    /** Starts swaps for approved results whose file nobody is watching. */
    const queueSwaps = () => {
      for (const item of store.swapsToStart()) {
        // A swap cut short is finished whatever Plex says: the library is already part-changed.
        if (item.status === "approved" && ctx.plex.isPlaying(item.path)) continue;
        ctx.enqueue<SwapPayload>(
          "swap",
          { fileId: item.id, name: path.basename(item.path) },
          { dedupeKey: swapKey(item.id) },
        );
      }
    };

    /** In automatic mode, approves results that passed, within the daily limit. */
    const autoApprove = () => {
      const v = ctx.settings.values("transcode");
      if (v.mode !== "auto") return;
      const limit = Number(v.maxSwapsPerDay);
      let room =
        limit > 0
          ? limit -
            store.swappedSince(new Date(Date.now() - 86_400_000).toISOString()) -
            store.countOutcomes(["approved", "swapping"])
          : Number.POSITIVE_INFINITY;
      for (const id of store.cleanAwaitingApproval()) {
        if (room <= 0) break;
        store.setOutcomeStatus(id, "approved", null);
        room--;
      }
      queueSwaps();
    };

    /**
     * Keeps up to `maxWaiting` results waiting or in progress, biggest saving first. Each
     * encoder gets one file queued at a time, so files go to whichever encoder frees up first;
     * the CPU (better compression) is offered the biggest saving.
     */
    const feed = () => {
      autoApprove();
      const v = ctx.settings.values("transcode");
      if (v.mode !== "approval" && v.mode !== "auto") return;
      const encoding = ctx.settings.values("encoding");
      const encoders: ("gpu" | "cpu")[] = [];
      if (encoding.cpuEnabled && Number(encoding.cpuCrf) > 0) encoders.push("cpu");
      if (encoding.gpuEnabled) encoders.push("gpu");
      let free =
        Number(v.maxWaiting) -
        store.countOutcomes(["awaiting-approval", "approved", "swapping"]) -
        ctx.activeJobs("encode");
      for (const encoder of encoders) {
        if (free <= 0) return;
        if (store.queuedEncodes(encoder) > 0) continue;
        const file = store.nextCandidates(1)[0];
        if (!file) return;
        ctx.enqueue<EncodePayload>(
          "encode",
          { fileId: file.id, name: path.basename(file.path), encoder },
          { dedupeKey: encodeKey(file.id) },
        );
        free--;
      }
    };

    /**
     * Removes work folders that no result or running encode needs any more. The frames of the
     * latest swaps are kept for "Recently replaced".
     */
    const sweep = async () => {
      const keep = store.idsWithResults();
      for (const item of store.history(RECENT_KEPT)) keep.add(item.fileId);
      for (const name of await readdir(workRoot).catch(() => [] as string[])) {
        const id = Number(name);
        if (!Number.isInteger(id) || keep.has(id) || store.detail(id)?.encoding) continue;
        await rm(path.join(workRoot, name), { recursive: true, force: true });
      }
    };

    ctx.defineJob<Record<string, never>, unknown>("scan", {
      slot: "general",
      title: () => "Scan the library",
      run: async (job) => {
        job.progress(null, libraryLock.busy ? "Waiting for a swap to finish…" : "Starting…");
        const result = await libraryLock.run(
          () =>
            runScan(job, {
              store,
              settings: ctx.settings,
              integrations: ctx.integrations,
            }),
          job.signal,
        );
        feed();
        return result;
      },
    });

    ctx.defineJob<SwapPayload, SwapResult>("swap", {
      slot: "general",
      title: (p) => `Swap in ${p.name}`,
      run: (job) => {
        job.progress(
          null,
          libraryLock.busy ? "Waiting for the library scan to finish…" : "Starting…",
        );
        return runSwap(job, {
          store,
          workRoot,
          lock: libraryLock,
          isPlaying: (file) => ctx.plex.isPlaying(file),
          rescan: (file, folder) => rescan(ctx.integrations, file.arr, folder),
          onFinished: () => {
            // The new file is read by the next scan; a free approval slot means another encode.
            if (store.outcome(job.payload.fileId)?.status === "done") scan();
            feed();
          },
        });
      },
    });

    const squishDeps = (): SquishDeps => ({
      store,
      settings: ctx.settings,
      lock: libraryLock,
      isPlaying: (file) => ctx.plex.isPlaying(file),
      rescan: (arr, folder) => rescan(ctx.integrations, arr, folder),
      pauseMs: 2000,
    });

    ctx.defineJob<Record<string, never>, SquishCheckResult>("squish-check", {
      slot: "general",
      title: () => "Look for [SQUISH] names",
      run: (job) => runSquishCheck(job, squishDeps()),
    });

    ctx.defineJob<SquishRenamePayload, SquishRenameResult>("squish-rename", {
      slot: "general",
      title: (p) =>
        p.title
          ? `Remove [SQUISH] from ${path.basename(p.title)}`
          : "Remove [SQUISH] from every title",
      run: (job) => runSquishRename(job, squishDeps()),
    });

    ctx.defineJob<Record<string, never>, Calibration>("calibrate", {
      slot: "cpu",
      title: () => "Calibrate the CPU encoder",
      run: (job) =>
        runCalibration(job, {
          store,
          settings: ctx.settings,
          workDir: path.join(ctx.dataDir, "calibration"),
        }),
    });

    ctx.defineJob<EncodePayload, EncodeResult>("encode", {
      slot: (p) => p.encoder ?? "gpu",
      title: (p) => `Transcode ${p.name}${p.encoder === "cpu" ? " (CPU)" : ""}`,
      run: (job) =>
        runEncode(job, {
          store,
          settings: ctx.settings,
          workRoot,
          version: ctx.version,
          onFinished: feed,
        }),
      // Interrupted by a restart: throw away the partial result; it's encoded again.
      recover: async (_job, payload) => {
        await rm(workDirFor(workRoot, payload.fileId), { recursive: true, force: true });
      },
    });

    /** Once a day, when the night window ends, sends what happened since the last summary. */
    const sendMorningSummary = async () => {
      const telegram = ctx.integrations.telegram;
      if (!ctx.settings.values("transcode").morningSummary || !telegram.configured()) return;
      const info = ctx.scheduler.info();
      const now = new Date();
      const today = localDate(now, info.timeZone);
      const sinceEnd = minutesOfDay(localClock(now, info.timeZone)) - minutesOfDay(info.windowEnd);
      if (sinceEnd < 0 || store.meta<string>("summaryDate") === today) return;
      store.setMeta("summaryDate", today);
      // Kondo wasn't running at the time: skip today's rather than send it hours late.
      if (sinceEnd > 120) return;
      const since =
        store.meta<string>("summarySince") ?? new Date(now.getTime() - 86_400_000).toISOString();
      store.setMeta("summarySince", now.toISOString());
      const s = store.summary(librarySettings(ctx.settings).roots);
      const mode = ctx.settings.values("transcode").mode;
      const text = morningSummary(store.logEntries({ since, limit: 100_000 }), {
        savedSoFar: s.done.savedBytes,
        toTranscode: s.toTranscode.count,
        awaitingApproval: s.awaitingApproval,
        idleBecause: info.paused
          ? "paused"
          : mode === "off"
            ? "encoding is switched off"
            : s.toTranscode.count === 0
              ? "nothing left to do"
              : null,
      });
      try {
        await telegram.send(text);
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "couldn't send the morning summary");
      }
    };
    ctx.every(() => 60_000, sendMorningSummary, 60_000);

    ctx.every(
      () => 5 * 60_000,
      async () => {
        await sweep();
        feed();
        queueSwaps();
      },
      15_000,
    );

    ctx.every(
      () => Number(ctx.settings.values("transcode").scanEveryMinutes) * 60_000,
      () => {
        scan();
      },
      30_000,
    );
    // New folders or thresholds: look again (unchanged files aren't re-read).
    ctx.events.subscribe((event) => {
      if (event.type === "settings.changed" && event.scope === "transcode") {
        scan();
        feed();
      }
      // An encoder switched on, or the CPU calibrated.
      if (event.type === "settings.changed" && event.scope === "encoding") feed();
    });

    ctx.addHealthCheck({
      id: "library",
      label: "Library",
      check: async () => {
        const { roots } = librarySettings(ctx.settings);
        if (roots.length === 0) return { status: "warn", message: "No library folders set yet" };
        for (const root of roots) {
          const ok = await stat(root).then(
            (s) => s.isDirectory(),
            () => false,
          );
          if (!ok)
            return { status: "error", message: `Can't read ${root}. Is the media share mounted?` };
        }
        const last = store.lastScan();
        if (last?.error) return { status: "warn", message: `Last scan failed: ${last.error}` };
        const s = store.summary(roots);
        return { status: "ok", message: `${s.files} files; ${s.toTranscode.count} to transcode` };
      },
    });

    ctx.routes((app) => {
      app.get("/summary", async () => store.summary(librarySettings(ctx.settings).roots));

      app.get<{
        Querystring: {
          filter?: string;
          reason?: string;
          q?: string;
          sort?: string;
          limit?: string;
          offset?: string;
        };
      }>("/files", async (request) => {
        const q = request.query;
        return store.page({
          filter: FILTERS.has(q.filter as FileFilter) ? (q.filter as FileFilter) : "transcode",
          reason: q.reason || undefined,
          search: q.q?.trim() || undefined,
          sort: SORTS.has(q.sort as FileSort) ? (q.sort as FileSort) : "saving",
          limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200),
          offset: Math.max(Number(q.offset) || 0, 0),
        });
      });

      app.get<{ Params: { id: string } }>("/files/:id", async (request, reply) => {
        const detail = store.detail(Number(request.params.id));
        return detail ?? reply.code(404).send({ error: "No such file" });
      });

      app.post("/scan", async (_request, reply) => reply.code(202).send(scan()));

      // Encode one file now, outside the night window (it still gives way to Plex).
      app.post<{ Params: { id: string } }>("/files/:id/encode", async (request, reply) => {
        const file = store.detail(Number(request.params.id));
        if (!file) return reply.code(404).send({ error: "No such file" });
        if (file.decision !== "transcode") {
          return reply.code(409).send({ error: "This file isn't marked for transcoding" });
        }
        const job = ctx.enqueue<EncodePayload>(
          "encode",
          { fileId: file.id, name: path.basename(file.path) },
          { dedupeKey: encodeKey(file.id), force: true, priority: 10 },
        );
        return reply.code(202).send(job);
      });

      app.get("/calibration", async () => ({
        result: store.meta<Calibration>(CALIBRATION_KEY),
        running: ctx.activeJobs("calibrate") > 0,
      }));

      // Runs now (outside the night window), still giving way to Plex.
      app.post("/calibration", async (_request, reply) =>
        reply
          .code(202)
          .send(ctx.enqueue("calibrate", {}, { dedupeKey: "transcode:calibrate", force: true })),
      );

      app.get("/squish", async () => store.squishSummary());

      app.get<{ Querystring: { title?: string } }>("/squish/items", async (request) =>
        store
          .squishItems(String(request.query.title ?? ""))
          .map(({ fullPath: _, ...item }) => item),
      );

      app.post("/squish/check", async (_request, reply) =>
        reply
          .code(202)
          .send(ctx.enqueue("squish-check", {}, { dedupeKey: "transcode:squish-check" })),
      );

      // One title, or all of them (one at a time).
      app.post<{ Body: { title?: string } }>("/squish/rename", async (request, reply) => {
        const title = request.body?.title;
        if (title !== undefined && !store.squishTitlesToDo().includes(title)) {
          return reply.code(404).send({ error: "Nothing to rename there" });
        }
        const job = ctx.enqueue<SquishRenamePayload>("squish-rename", title ? { title } : {}, {
          dedupeKey: `transcode:squish-rename:${title ?? "*"}`,
        });
        return reply.code(202).send(job);
      });

      // Forget a failed, rejected or not-worth-it result so the file is offered again.
      app.post<{ Params: { id: string } }>("/files/:id/retry", async (request, reply) => {
        const id = Number(request.params.id);
        const status = store.outcome(id)?.status;
        if (status !== "failed" && status !== "rejected" && status !== "not-worth-it") {
          return reply.code(409).send({ error: "There's no result here to try again" });
        }
        store.forgetOutcome(id);
        // The scan decides the file afresh; the feeder then picks it up in its turn.
        return reply.code(202).send(scan());
      });

      app.get("/approvals", async () => store.approvals());

      // The permanent history, newest first; `before` pages back.
      app.get<{ Querystring: { before?: string; limit?: string } }>("/log", async (request) => {
        const kept = new Set(store.history(RECENT_KEPT).map((h) => h.fileId));
        return store
          .logEntries({
            before: request.query.before || undefined,
            limit: Math.min(Math.max(Number(request.query.limit) || 200, 1), 1000),
          })
          .map((entry) => ({
            ...entry,
            framesKept: entry.kind === "replaced" && kept.has(entry.fileId),
          }));
      });

      app.post<{ Params: { id: string } }>("/approvals/:id/approve", async (request, reply) => {
        const id = Number(request.params.id);
        if (store.outcome(id)?.status !== "awaiting-approval") {
          return reply.code(409).send({ error: "Nothing waiting for approval here" });
        }
        const outcome = store.setOutcomeStatus(id, "approved", null);
        queueSwaps();
        return outcome;
      });

      app.post<{ Params: { id: string } }>("/approvals/:id/reject", async (request, reply) => {
        const id = Number(request.params.id);
        const status = store.outcome(id)?.status;
        if (status !== "awaiting-approval" && status !== "approved") {
          return reply.code(409).send({ error: "Nothing waiting for approval here" });
        }
        if (store.swapActive(id)) {
          return reply.code(409).send({ error: "It's being swapped in right now" });
        }
        await rm(workDirFor(workRoot, id), { recursive: true, force: true });
        const outcome = store.setOutcomeStatus(id, "rejected");
        feed();
        return outcome;
      });

      // Comparison frames and the result itself: /work/12/frame-source-0.jpg, /work/12/output.mkv
      app.get<{ Params: { id: string; name: string } }>(
        "/work/:id/:name",
        async (request, reply) => {
          const { id, name } = request.params;
          if (!/^\d+$/.test(id) || !/^(frame-(source|output)-\d\.jpg|output\.mkv)$/.test(name)) {
            return reply.code(404).send({ error: "Not found" });
          }
          if (name.endsWith(".jpg")) reply.header("cache-control", "private, max-age=3600");
          return sendFile(request, reply, path.join(workDirFor(workRoot, Number(id)), name));
        },
      );

      // The original, to compare against the result (read only).
      app.get<{ Params: { id: string } }>("/files/:id/original", async (request, reply) => {
        const file = store.detail(Number(request.params.id));
        if (!file) return reply.code(404).send({ error: "No such file" });
        return sendFile(request, reply, path.join(file.root, file.path));
      });
    });

    ctx.setCard(() => {
      const s = store.summary(librarySettings(ctx.settings).roots);
      if (s.roots.length === 0)
        return { status: "warn", lines: ["Set the library folders in Settings."] };
      if (s.files === 0) {
        return s.lastScan?.error
          ? { status: "warn", lines: [`Last scan failed: ${s.lastScan.error}`] }
          : { status: "ok", lines: ["Waiting for the first scan…"] };
      }
      const saving = s.toTranscode.bytes - s.toTranscode.estimatedBytes;
      const lines = [
        `${s.files.toLocaleString("en-GB")} videos (${terabytes(s.bytes)})`,
        `${s.toTranscode.count.toLocaleString("en-GB")} to transcode · about ${terabytes(saving)} to save`,
      ];
      if (s.done.count > 0) {
        lines.push(
          `${s.done.count.toLocaleString("en-GB")} done · ${terabytes(s.done.savedBytes)} saved`,
        );
      }
      if (s.awaitingApproval > 0) lines.push(`${s.awaitingApproval} waiting for your approval`);
      if (s.notYetRead > 0) lines.push(`${s.notYetRead.toLocaleString("en-GB")} still to be read`);
      if (s.problems > 0) lines.push(`${s.problems} couldn't be read`);
      return { status: s.problems > 0 ? "warn" : "ok", lines };
    });
  },
});
