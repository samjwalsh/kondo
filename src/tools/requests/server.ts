import { defineTool } from "../../server/core/tools.js";
import { errorMessage } from "../../server/integrations/http.js";
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

    ctx.defineJob<{ afterPlex?: boolean }, CheckResult>("check", {
      slot: "general",
      title: (p) =>
        p.afterPlex
          ? "Plex added something: email people whose requests are ready"
          : "Email people whose requests are ready",
      run: async (job) => {
        if (job.payload.afterPlex) {
          // Seerr only notices Plex's new items on its 5-minute scan; run it now instead.
          try {
            await seerr.syncRecentlyAdded();
          } catch (error) {
            job.log(`Couldn't run Seerr's Plex scan: ${errorMessage(error)}`, "warn");
          }
        }
        const result = await runCheck({ store, seerr, plex, email, names });
        for (const e of result.errors) job.log(e, "warn");
        if (result.before > 0)
          job.log(`First check: ${result.before} request(s) were already ready, so no emails.`);
        return result;
      },
    });
    const ready = () => enabled() && missing().length === 0;
    const check = () => ctx.enqueue("check", {}, { dedupeKey: "requests:check" });

    // The safety net: also catches anything the Plex notifications below miss.
    ctx.every(
      () => 5 * 60_000,
      () => {
        if (ready()) check();
      },
      60_000,
    );

    // As soon as Plex finishes adding a film or episode, sync Seerr and check. Plex sends a few
    // notifications per item (and one per episode of a season pack), so wait for a quiet
    // moment: 5 s after the last one, or 30 s after the first at most.
    const QUIET_MS = 5_000;
    const MAX_WAIT_MS = 30_000;
    let timer: NodeJS.Timeout | null = null;
    let firstAt = 0;
    let again = false;
    const afterPlex = () => {
      timer = null;
      if (!ready()) return;
      // One already queued or running: run another when it's done, so nothing just added is missed.
      if (ctx.activeJobs("check") > 0) again = true;
      else ctx.enqueue("check", { afterPlex: true }, { dedupeKey: "requests:check" });
    };
    ctx.events.subscribe((event) => {
      if (event.type === "plex.library.changed") {
        const now = Date.now();
        if (!timer) firstAt = now;
        else clearTimeout(timer);
        timer = setTimeout(afterPlex, Math.max(0, Math.min(QUIET_MS, firstAt + MAX_WAIT_MS - now)));
      } else if (
        again &&
        event.type === "job.updated" &&
        event.job.tool === "requests" &&
        event.job.state !== "queued" &&
        event.job.state !== "running" &&
        ctx.activeJobs("check") === 0
      ) {
        again = false;
        afterPlex();
      }
    });

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
      app.get("/dismissed", async () => store.dismissed());
      // "Don't email": the request is never emailed about (it must be in the waiting list).
      app.post<{ Params: { id: string } }>("/requests/:id/dismiss", async (request, reply) => {
        const id = Number(request.params.id);
        const list = JSON.parse(store.meta("waitingList") ?? "[]") as WaitingRequest[];
        const w = list.find((x) => x.requestId === id);
        if (!w) return reply.code(404).send({ error: "That request isn't waiting" });
        store.save({
          requestId: id,
          at: new Date().toISOString(),
          status: "dismissed",
          type: w.type,
          title: w.title,
          detail: w.reason,
          user: w.user,
          attempts: 0,
          error: null,
        });
        store.setMeta("waitingList", JSON.stringify(list.filter((x) => x.requestId !== id)));
        store.setMeta("waiting", String(list.length - 1));
        return { ok: true };
      });
      // Undo: the next check treats it like any other request again.
      app.post<{ Params: { id: string } }>("/requests/:id/undismiss", async (request, reply) => {
        const id = Number(request.params.id);
        if (store.get(id)?.status !== "dismissed") {
          return reply.code(404).send({ error: "That request isn't dismissed" });
        }
        store.remove(id);
        check();
        return { ok: true };
      });
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
