import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Lock } from "../../server/core/lock.js";
import { sendFile } from "../../server/core/sendFile.js";
import { defineTool, type Integrations } from "../../server/core/tools.js";
import { errorMessage } from "../../server/integrations/http.js";
import type { SettingsSection } from "../../shared/settings.js";
import { type EncodePayload, type EncodeResult, runEncode, workDirFor } from "./encode.js";
import { librarySettings, runScan } from "./scan.js";
import type { FileDetail, FileFilter, FileSort } from "./shared.js";
import { encodeKey, LibraryStore, migrations, swapKey } from "./store.js";
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
      ],
      help: "Encodes run in the night window (and idle mode). Results wait in Kondo's own folder; the library isn't touched.",
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

const FILTERS = new Set<FileFilter>(["transcode", "skip", "error", "all"]);
const SORTS = new Set<FileSort>(["saving", "size", "path"]);

/** Tells Plex and Sonarr/Radarr that a file was replaced. Each is best effort. */
async function rescanAfterSwap(
  integrations: Integrations,
  file: FileDetail,
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
  if (file.arr) {
    const client = integrations[file.arr.app];
    if (client.configured()) {
      try {
        await client.rescan(file.arr.id);
        lines.push(`Asked ${client.name} to rescan ${file.arr.title}`);
      } catch (error) {
        lines.push(`Couldn't ask ${client.name} to rescan: ${errorMessage(error)}`);
      }
    }
  }
  return lines;
}

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

    /** Keeps up to `maxWaiting` results waiting or in progress, biggest saving first. */
    const feed = () => {
      const v = ctx.settings.values("transcode");
      if (v.mode !== "approval") return;
      let free =
        Number(v.maxWaiting) -
        store.countOutcomes(["awaiting-approval", "approved", "swapping"]) -
        ctx.activeJobs("encode");
      if (free <= 0) return;
      for (const file of store.nextCandidates(free)) {
        ctx.enqueue<EncodePayload>(
          "encode",
          { fileId: file.id, name: path.basename(file.path) },
          { dedupeKey: encodeKey(file.id) },
        );
        free--;
      }
    };

    /** Removes work folders that no result or running encode needs any more. */
    const sweep = async () => {
      const keep = store.idsWithResults();
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
          rescan: (file, folder) => rescanAfterSwap(ctx.integrations, file, folder),
          onFinished: () => {
            // The new file is read by the next scan; a free approval slot means another encode.
            if (store.outcome(job.payload.fileId)?.status === "done") scan();
            feed();
          },
        });
      },
    });

    ctx.defineJob<EncodePayload, EncodeResult>("encode", {
      slot: "gpu",
      title: (p) => `Transcode ${p.name}`,
      run: (job) =>
        runEncode(job, {
          store,
          settings: ctx.settings,
          workRoot,
          version: ctx.version,
          encoder: "gpu",
          onFinished: feed,
        }),
      // Interrupted by a restart: throw away the partial result; it's encoded again.
      recover: async (_job, payload) => {
        await rm(workDirFor(workRoot, payload.fileId), { recursive: true, force: true });
      },
    });

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

      app.get("/approvals", async () => store.approvals());

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
