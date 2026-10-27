import { defineTool } from "../../server/core/tools.js";
import { errorMessage } from "../../server/integrations/http.js";
import type { SettingsSection } from "../../shared/settings.js";
import { type CheckResult, DEFAULT_BLOCKED, runCheck } from "./check.js";
import type { DownloadsMode, DownloadsStatus } from "./shared.js";
import { DownloadsStore, migrations } from "./store.js";

export const downloadsSettings: SettingsSection = {
  scope: "downloads",
  title: "Downloads",
  group: "tool",
  description:
    "Fake releases carry a program (e.g. “Episode.exe”) instead of the video. Sonarr and Radarr refuse to import them but don't look for another release, so the episode stays missing.",
  fields: [
    {
      key: "mode",
      label: "Fake downloads",
      type: "select",
      default: "report",
      options: [
        { value: "off", label: "Off: don't check" },
        { value: "report", label: "Report only: list them, change nothing" },
        {
          value: "remove",
          label: "Remove: blocklist in Sonarr/Radarr (which then search again) and delete",
        },
      ],
    },
    {
      key: "everyMinutes",
      label: "Check every (minutes)",
      type: "number",
      default: 10,
      min: 2,
      max: 1440,
    },
    {
      key: "categories",
      label: "qBittorrent categories to check",
      type: "lines",
      default: "sonarr\nradarr",
      help: "One per line. Downloads in other categories (your own) are never touched.",
    },
    {
      key: "extensions",
      label: "File types that mark a fake",
      type: "lines",
      default: DEFAULT_BLOCKED.join("\n"),
      help: "One per line, without the dot. A torrent containing any of these is treated as fake.",
    },
  ],
};

const lines = (v: unknown) =>
  String(v ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

export default defineTool({
  id: "downloads",
  name: "Downloads",
  description: "Clears fake releases out of Sonarr's and Radarr's downloads so they search again.",
  settings: [downloadsSettings],
  migrations,

  register(ctx) {
    const store = new DownloadsStore(ctx.db);
    const qb = ctx.integrations.qbittorrent;
    const mode = () => String(ctx.settings.values("downloads").mode) as DownloadsMode;
    const check = () => ctx.enqueue("check", {}, { dedupeKey: "downloads:check" });

    ctx.defineJob<Record<string, never>, CheckResult>("check", {
      slot: "general",
      title: () => "Look for fake downloads",
      run: async (job) => {
        const v = ctx.settings.values("downloads");
        try {
          const result = await runCheck(job, {
            store,
            qbittorrent: qb,
            arrs: [ctx.integrations.sonarr, ctx.integrations.radarr],
            mode: mode(),
            categories: lines(v.categories),
            extensions: lines(v.extensions),
          });
          store.saveCheck({
            at: new Date().toISOString(),
            torrents: result.torrents,
            fakes: result.fakes - result.removed,
            error: null,
          });
          return result;
        } catch (error) {
          store.saveCheck({
            at: new Date().toISOString(),
            torrents: 0,
            fakes: 0,
            error: errorMessage(error),
          });
          throw error;
        }
      },
    });

    ctx.every(
      () => Number(ctx.settings.values("downloads").everyMinutes) * 60_000,
      () => {
        if (mode() !== "off" && qb.configured()) check();
      },
      60_000,
    );
    ctx.events.subscribe((event) => {
      if (event.type === "settings.changed" && event.scope === "downloads" && mode() !== "off") {
        if (qb.configured()) check();
      }
    });

    const status = (): DownloadsStatus => {
      const last = store.lastCheck();
      return {
        mode: mode(),
        configured: qb.configured(),
        lastCheck: last,
        waiting: mode() === "remove" ? 0 : (last?.fakes ?? 0),
        removed: store.countRemoved(),
      };
    };

    ctx.routes((app) => {
      app.get("/status", async () => status());
      app.get<{ Querystring: { limit?: string } }>("/log", async (request) =>
        store.entries({ limit: Math.min(Math.max(Number(request.query.limit) || 50, 1), 500) }),
      );
      app.post("/check", async (_request, reply) => {
        if (!qb.configured()) {
          return reply.code(409).send({ error: "Set up qBittorrent in Settings first" });
        }
        return reply.code(202).send(check());
      });
    });

    ctx.setCard(() => {
      const s = status();
      if (!s.configured) return { status: "warn", lines: ["Set up qBittorrent in Settings."] };
      if (s.mode === "off") return { status: "ok", lines: ["Switched off."] };
      const out: string[] = [];
      if (s.lastCheck?.error) {
        return { status: "warn", lines: [`Last check failed: ${s.lastCheck.error}`] };
      }
      out.push(
        s.lastCheck ? `${s.lastCheck.torrents} downloads checked` : "Waiting for the first check…",
      );
      if (s.waiting > 0) {
        out.push(`${s.waiting} fake download(s) found; set Mode to Remove to clear them`);
      }
      if (s.removed > 0) out.push(`${s.removed} fake download(s) removed so far`);
      return { status: s.waiting > 0 ? "warn" : "ok", lines: out };
    });

    ctx.addSummary((since) => {
      const recent = store.entries({ since, limit: 1000 });
      const removed = recent.filter((e) => e.action === "removed");
      const out: string[] = [];
      if (removed.length > 0) {
        const names = removed.map((e) => e.what ?? e.name).slice(0, 5);
        out.push(
          `Removed ${removed.length} fake download(s), searching again: ${names.join(", ")}${removed.length > 5 ? "…" : ""}.`,
        );
      }
      const waiting = status().waiting;
      if (waiting > 0) out.push(`${waiting} fake download(s) waiting (report-only mode).`);
      const errors = recent.filter((e) => e.action === "error").length;
      if (errors > 0) out.push(`${errors} fake download(s) couldn't be removed; see Downloads.`);
      return out;
    });
  },
});
