import { defineTool } from "../../server/core/tools.js";
import type { SettingsSection } from "../../shared/settings.js";
import { type CheckResult, MAX_ATTEMPTS, runCheck } from "./check.js";
import type { RequestsStatus, WaitingRequest } from "./shared.js";
import { migrations, RequestsStore } from "./store.js";

export const requestsSettings: SettingsSection = {
  scope: "requests",
  title: "Request emails",
  group: "tool",
  description:
    "Emails whoever requested a film or show in Seerr once they can start watching it: a film once it's in Plex, a show once episode 1 of the first season they asked for is. Needs Seerr (with its API key), Email and Plex set up. Turn off Seerr's own email notifications so nobody gets two.",
  fields: [{ key: "enabled", label: "Send request emails", type: "boolean", default: false }],
};

const WEEK = 7 * 24 * 3_600_000;

export default defineTool({
  id: "requests",
  name: "Request emails",
  description: "Tells people by email when the film or show they requested is ready to watch.",
  settings: [requestsSettings],
  migrations,

  register(ctx) {
    const store = new RequestsStore(ctx.db);
    const { seerr, email, plex } = ctx.integrations;
    const names = new Map<string, string>();
    const enabled = () => ctx.settings.values("requests").enabled === true;
    const missing = () => [
      ...(seerr.configured() ? [] : ["Seerr address and API key"]),
      ...(email.configured() ? [] : ["Email (Resend) API key and From address"]),
    ];

    ctx.defineJob<Record<string, never>, CheckResult>("check", {
      slot: "general",
      title: () => "Email people whose requests are ready",
      run: async (job) => {
        const result = await runCheck({ store, seerr, plex, email, names });
        for (const e of result.errors) job.log(e, "warn");
        if (result.before > 0)
          job.log(`First check: ${result.before} request(s) were already ready, so no emails.`);
        return result;
      },
    });
    const check = () => ctx.enqueue("check", {}, { dedupeKey: "requests:check" });

    // Seerr notices new files in Plex within a few minutes, so checking every 5 is enough.
    ctx.every(
      () => 5 * 60_000,
      () => {
        if (enabled() && missing().length === 0) check();
      },
      60_000,
    );

    const status = (): RequestsStatus => ({
      enabled: enabled(),
      missing: missing(),
      checkedAt: store.meta("checkedAt"),
      lastError: store.meta("lastError"),
      waiting: Number(store.meta("waiting") ?? 0),
    });

    ctx.routes((app) => {
      app.get("/status", async () => status());
      app.get<{ Querystring: { limit?: string } }>("/notices", async (request) =>
        store.recent({ limit: Math.min(Math.max(Number(request.query.limit) || 30, 1), 200) }),
      );
      app.get(
        "/waiting",
        async () => JSON.parse(store.meta("waitingList") ?? "[]") as WaitingRequest[],
      );
      app.post("/check", async (_request, reply) => {
        const gaps = missing();
        if (gaps.length > 0) {
          return reply.code(409).send({ error: `Set up ${gaps.join(" and ")} in Settings first` });
        }
        return reply.code(202).send(check());
      });
    });

    ctx.setCard(() => {
      const s = status();
      if (!s.enabled) return { status: "ok", lines: ["Switched off."] };
      if (s.missing.length > 0)
        return { status: "warn", lines: [`Needs ${s.missing.join(" and ")} in Settings.`] };
      if (!s.checkedAt) return { status: "ok", lines: ["Waiting for the first check…"] };
      const week = store.recent({ since: new Date(Date.now() - WEEK).toISOString(), limit: 500 });
      const sent = week.filter((n) => n.status === "sent").length;
      const gaveUp = week.filter((n) => n.status === "failed" && n.attempts >= MAX_ATTEMPTS);
      const lines = [`${sent} sent in the last 7 days; ${s.waiting} request(s) not ready yet.`];
      if (gaveUp.length > 0) lines.push(`${gaveUp.length} couldn't be sent: see Request emails.`);
      if (s.lastError) lines.push(`Last check: ${s.lastError}`);
      return { status: gaveUp.length > 0 || s.lastError ? "warn" : "ok", lines };
    });

    ctx.addSummary((since) => {
      const notices = store.recent({ since, limit: 500 });
      const sent = notices.filter((n) => n.status === "sent");
      const failed = notices.filter((n) => n.status === "failed").length;
      const out: string[] = [];
      if (sent.length > 0)
        out.push(
          `Emailed ${sent.length} request(s) ready to watch: ${sent.map((n) => n.title).join(", ")}.`,
        );
      if (failed > 0) out.push(`${failed} request email(s) failed; see Request emails.`);
      return out;
    });
  },
});
