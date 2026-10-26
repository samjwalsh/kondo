import { stat } from "node:fs/promises";
import { defineTool } from "../../server/core/tools.js";
import type { SettingsSection } from "../../shared/settings.js";
import { librarySettings, runScan } from "./scan.js";
import type { FileFilter, FileSort } from "./shared.js";
import { LibraryStore, migrations } from "./store.js";

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
      default: 3.5,
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
  ],
};

const FILTERS = new Set<FileFilter>(["transcode", "skip", "error", "all"]);
const SORTS = new Set<FileSort>(["saving", "size", "path"]);

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
    const scan = () => ctx.enqueue("scan", {}, { dedupeKey: "transcode:scan" });

    ctx.defineJob<Record<string, never>, unknown>("scan", {
      slot: "general",
      title: () => "Scan the library",
      run: (job) => runScan(job, { store, settings: ctx.settings, integrations: ctx.integrations }),
    });

    ctx.every(
      () => Number(ctx.settings.values("transcode").scanEveryMinutes) * 60_000,
      () => {
        scan();
      },
      30_000,
    );
    // New folders or thresholds: look again (unchanged files aren't re-read).
    ctx.events.subscribe((event) => {
      if (event.type === "settings.changed" && event.scope === "transcode") scan();
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
      if (s.notYetRead > 0) lines.push(`${s.notYetRead.toLocaleString("en-GB")} still to be read`);
      if (s.problems > 0) lines.push(`${s.problems} couldn't be read`);
      return { status: s.problems > 0 ? "warn" : "ok", lines };
    });
  },
});
