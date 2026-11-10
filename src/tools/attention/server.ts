import { defineTool } from "../../server/core/tools.js";
import { type SettingsSection, splitLines } from "../../shared/settings.js";
import { attentionStatus, runCheck, summaryLines } from "./check.js";
import { AttentionStore, migrations } from "./store.js";

export const attentionSettings: SettingsSection = {
  scope: "attention",
  title: "Needs a look",
  group: "tool",
  description:
    "Problems that don't fail loudly but never sort themselves out. Kondo checks every hour and lists only the ones that have lasted, at the top of the morning summary.",
  fields: [
    {
      key: "stuckDays",
      label: "Report missing items and files to replace after (days)",
      type: "number",
      default: 14,
      min: 1,
      max: 365,
      help: "How long an episode or movie can stay missing, or stuck with a file Sonarr/Radarr would replace (e.g. only a dub), while Kondo keeps searching.",
    },
    {
      key: "stuckHours",
      label: "Report stuck downloads and health warnings after (hours)",
      type: "number",
      default: 6,
      min: 1,
      max: 168,
      help: "Downloads Sonarr/Radarr can't import on their own, and their own health warnings.",
    },
    {
      key: "ignoreHealth",
      label: "Sonarr/Radarr health checks to ignore",
      type: "lines",
      default: "",
      placeholder: "AllowedHostsCheck",
      help: "One per line: the check's name, as shown on the Needs a look page.",
    },
    {
      key: "bazarrUrl",
      label: "Bazarr address",
      type: "url",
      default: "",
      placeholder: "http://bazarr:6767",
      help: "Reported if it stops answering. Leave empty to skip.",
    },
    {
      key: "seerrUrl",
      label: "Seerr / Overseerr address",
      type: "url",
      default: "",
      placeholder: "http://seerr:5055",
      help: "Reported if it stops answering. Leave empty to skip.",
    },
  ],
};

export default defineTool({
  id: "attention",
  name: "Needs a look",
  description:
    "Lists what needs a person: items never found, downloads stuck before import, Sonarr/Radarr warnings, Bazarr or Seerr down.",
  settings: [attentionSettings],
  migrations,

  register(ctx) {
    const store = new AttentionStore(ctx.db);
    const arrs = [ctx.integrations.sonarr, ctx.integrations.radarr];
    const values = () => ctx.settings.values("attention");
    const limits = () => ({
      stuckDays: Number(values().stuckDays),
      stuckHours: Number(values().stuckHours),
    });
    const check = () =>
      runCheck({
        store,
        arrs,
        ignoreHealth: splitLines(values().ignoreHealth),
        services: [
          { app: "bazarr", name: "Bazarr", url: String(values().bazarrUrl ?? "") },
          { app: "seerr", name: "Seerr", url: String(values().seerrUrl ?? "") },
        ],
      });

    ctx.defineJob<Record<string, never>, { errors: string[] }>("check", {
      slot: "general",
      title: () => "Look for things that need a person",
      run: async (job) => {
        const result = await check();
        for (const e of result.errors) job.log(e, "warn");
        return result;
      },
    });
    const enqueue = () => ctx.enqueue("check", {}, { dedupeKey: "attention:check" });
    ctx.every(
      () => 60 * 60_000,
      () => {
        enqueue();
      },
      2 * 60_000,
    );
    ctx.events.subscribe((event) => {
      if (event.type === "settings.changed" && event.scope === "attention") enqueue();
    });

    ctx.routes((app) => {
      app.get("/status", async () => attentionStatus(store, limits()));
      app.get("/items", async () => store.items());
      app.post("/check", async (_request, reply) => reply.code(202).send(enqueue()));
    });

    ctx.setCard(() => {
      const s = attentionStatus(store, limits());
      if (!s.checkedAt) return { status: "ok", lines: ["Waiting for the first check…"] };
      const lines = summaryLines(s).slice(1);
      if (s.errors.length > 0) lines.push(`Couldn't check: ${s.errors.join("; ")}`);
      return lines.length > 0
        ? { status: "warn", lines }
        : {
            status: "ok",
            lines: [`Nothing needs you.${s.watching > 0 ? ` Watching ${s.watching}.` : ""}`],
          };
    });

    ctx.addSummary(() => summaryLines(attentionStatus(store, limits())));
  },
});
