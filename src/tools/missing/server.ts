import { defineTool } from "../../server/core/tools.js";
import type { SettingsSection } from "../../shared/settings.js";
import { pickItems, runSearch, type SearchResult } from "./search.js";
import type { MissingStatus } from "./shared.js";
import { MissingStore, migrations } from "./store.js";

export const missingSettings: SettingsSection = {
  scope: "missing",
  title: "Missing search",
  group: "tool",
  description:
    "Sonarr and Radarr search for a missing episode or movie once, then only watch for new releases. This asks them to search again for a few missing items at a time, the ones searched longest ago first.",
  fields: [
    { key: "enabled", label: "Search for missing items", type: "boolean", default: false },
    {
      key: "everyHours",
      label: "Every (hours)",
      type: "number",
      default: 24,
      min: 1,
      max: 720,
      help: "24 = once a day, 168 = once a week.",
    },
    {
      key: "perRun",
      label: "Items per run (each for Sonarr and Radarr)",
      type: "number",
      default: 20,
      min: 1,
      max: 500,
      help: "Each item is one search on every indexer. Public indexers may block heavy use.",
    },
  ],
};

const HOUR = 3_600_000;

export default defineTool({
  id: "missing",
  name: "Missing",
  description: "Asks Sonarr and Radarr to search again for missing episodes and movies.",
  settings: [missingSettings],
  migrations,

  register(ctx) {
    const store = new MissingStore(ctx.db);
    const arrs = [ctx.integrations.sonarr, ctx.integrations.radarr];
    const values = () => ctx.settings.values("missing");
    const enabled = () => values().enabled === true;
    const perRun = () => Number(values().perRun);
    const search = () => ctx.enqueue("search", {}, { dedupeKey: "missing:search" });

    const status = (): MissingStatus => {
      const lastRunAt = store.lastRunAt();
      const everyHours = Number(values().everyHours);
      return {
        enabled: enabled(),
        everyHours,
        perRun: perRun(),
        lastRunAt,
        nextRunAt: !enabled()
          ? null
          : lastRunAt
            ? new Date(Date.parse(lastRunAt) + everyHours * HOUR).toISOString()
            : new Date().toISOString(),
      };
    };
    const due = () => {
      const next = status().nextRunAt;
      return next !== null && Date.parse(next) <= Date.now();
    };

    ctx.defineJob<Record<string, never>, SearchResult>("search", {
      slot: "general",
      title: () => "Search for missing episodes and movies",
      run: (job) => runSearch(job, { store, arrs, perRun: perRun() }),
    });

    // Checked every 10 minutes against the last run (kept in the database), so restarts
    // and setting changes neither skip a run nor add one.
    ctx.every(
      () => 10 * 60_000,
      () => {
        if (due() && arrs.some((a) => a.configured())) search();
      },
      5 * 60_000,
    );

    ctx.routes((app) => {
      app.get("/status", async () => status());
      app.get<{ Querystring: { limit?: string } }>("/runs", async (request) =>
        store.runs({ limit: Math.min(Math.max(Number(request.query.limit) || 20, 1), 200) }),
      );
      app.post("/search", async (_request, reply) => {
        if (!arrs.some((a) => a.configured())) {
          return reply.code(409).send({ error: "Set up Sonarr or Radarr in Settings first" });
        }
        return reply.code(202).send(search());
      });
      // What the next run would search for, without searching.
      app.get("/preview", async () => {
        const out: Record<string, { missing: number; next: string[] }> = {};
        for (const arr of arrs) {
          if (!arr.configured()) continue;
          const queued = await arr.queuedIds();
          const missing = (await arr.missing()).filter((item) => !queued.has(item.id));
          out[arr.app] = {
            missing: missing.length,
            next: pickItems(missing, queued, perRun()).map((item) => item.what),
          };
        }
        return out;
      });
    });

    ctx.setCard(() => {
      const s = status();
      if (!s.enabled) return { status: "ok", lines: ["Switched off."] };
      const latest = store.runs({ limit: 2 }).filter((r) => r.at === s.lastRunAt);
      const failed = latest.filter((r) => r.error);
      const lines = latest
        .filter((r) => !r.error)
        .map(
          (r) =>
            `${r.app === "sonarr" ? "Sonarr" : "Radarr"}: ${r.missing} missing, searched ${r.searched.length}`,
        );
      if (failed.length > 0)
        lines.push(`Last run failed: ${failed.map((r) => r.error).join("; ")}`);
      if (latest.length === 0) lines.push("Waiting for the first run…");
      return { status: failed.length > 0 ? "warn" : "ok", lines };
    });

    ctx.addSummary((since) => {
      const runs = store.runs({ since, limit: 100 });
      const searched = runs.reduce((n, r) => n + r.searched.length, 0);
      const out: string[] = [];
      if (searched > 0)
        out.push(`Asked Sonarr/Radarr to search again for ${searched} missing item(s).`);
      const errors = runs.filter((r) => r.error).length;
      if (errors > 0) out.push(`${errors} missing search(es) failed; see Missing.`);
      return out;
    });
  },
});
