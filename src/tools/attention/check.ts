// What needs a person: problems that don't fail loudly, they just never sort themselves out.
// Each check records what it sees now; only problems that have lasted are reported.

import type { ArrClient } from "../../server/integrations/arr.js";
import { errorMessage, request } from "../../server/integrations/http.js";
import type { AttentionItem, AttentionStatus } from "./shared.js";
import type { AttentionStore, SeenItem } from "./store.js";

const HOUR = 3_600_000;
/** A service has to be down for this long (two hourly checks) before it's reported. */
const SERVICE_GRACE_MS = HOUR;

export interface CheckDeps {
  store: AttentionStore;
  arrs: Pick<
    ArrClient,
    | "app"
    | "name"
    | "configured"
    | "missing"
    | "belowFormatCutoff"
    | "queuedIds"
    | "queueProblems"
    | "healthIssues"
  >[];
  /** Health check sources to leave out, e.g. "AllowedHostsCheck". */
  ignoreHealth: string[];
  services: { app: string; name: string; url: string }[];
  /** For tests. */
  ping?: (url: string) => Promise<void>;
  now?: () => number;
}

export async function ping(url: string): Promise<void> {
  // Any answer will do (a login page or 401 still means it's up); only no answer or a 5xx counts.
  try {
    await request(url, { timeoutMs: 15_000 });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== undefined && status < 500) return;
    throw error;
  }
}

export async function runCheck(deps: CheckDeps): Promise<{ errors: string[] }> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const errors: string[] = [];
  /** Reads one source; if it can't be read, what was seen before stays as it was. */
  const source = async (key: string, label: string, read: () => Promise<SeenItem[]>) => {
    try {
      deps.store.reconcile(key, await read(), at);
    } catch (error) {
      errors.push(`${label}: ${errorMessage(error)}`);
    }
  };

  for (const arr of deps.arrs) {
    if (!arr.configured()) continue;
    await source(`${arr.app}:wanted`, `${arr.name} wanted list`, async () => {
      // Items being downloaded stay on the list: a download that never finishes, or one that
      // fails and is replaced by another attempt, mustn't restart the clock.
      const queued = await arr.queuedIds();
      const detail = (id: number) => (queued.has(id) ? "Downloading" : null);
      // A film counts as available once it's in cinemas, but there's nothing to download until
      // its digital or disc release.
      const missing = (await arr.missing()).filter((i) => i.homeRelease !== null);
      const replace = await arr.belowFormatCutoff();
      return [
        ...missing.map((i) => ({
          id: `missing:${i.id}`,
          kind: "not-found" as const,
          app: arr.app,
          group: i.title,
          what: i.what,
          detail: detail(i.id),
        })),
        ...replace.map((i) => ({
          id: `replace:${i.id}`,
          kind: "replace" as const,
          app: arr.app,
          group: i.title,
          what: i.what,
          detail: detail(i.id),
        })),
      ];
    });
    await source(`${arr.app}:queue`, `${arr.name} queue`, async () =>
      (await arr.queueProblems()).map((q) => ({
        id: String(q.id),
        kind: q.stalled ? ("stalled" as const) : ("import" as const),
        app: arr.app,
        group: q.what,
        what: q.what,
        detail: q.problem,
      })),
    );
    await source(`${arr.app}:health`, `${arr.name} health`, async () =>
      (await arr.healthIssues())
        .filter((h) => !deps.ignoreHealth.includes(h.source))
        .map((h) => ({
          id: h.source,
          kind: "health" as const,
          app: arr.app,
          group: arr.name,
          what: h.message,
          detail: h.source,
        })),
    );
  }

  for (const service of deps.services) {
    if (!service.url) {
      deps.store.reconcile(`${service.app}:up`, [], at);
      continue;
    }
    let problem: string | null = null;
    try {
      await (deps.ping ?? ping)(service.url);
    } catch (error) {
      problem = errorMessage(error);
    }
    deps.store.reconcile(
      `${service.app}:up`,
      problem
        ? [
            {
              id: "down",
              kind: "service",
              app: service.app,
              group: service.name,
              what: `${service.name} isn't answering`,
              detail: problem,
            },
          ]
        : [],
      at,
    );
  }

  deps.store.setMeta("lastCheck", { at, errors });
  return { errors };
}

/** How long a problem must last before it's worth a person's time. */
export function isDue(
  item: AttentionItem,
  limits: { stuckDays: number; stuckHours: number },
  now: number,
): boolean {
  const age = now - Date.parse(item.firstSeen);
  // Kondo's Downloads tool clears stuck public downloads within hours; what's left after the
  // longer wait is one it won't touch (a private tracker) or keeps coming back.
  if (item.kind === "not-found" || item.kind === "replace" || item.kind === "stalled")
    return age >= limits.stuckDays * 24 * HOUR;
  if (item.kind === "service") return age >= SERVICE_GRACE_MS;
  return age >= limits.stuckHours * HOUR;
}

export function attentionStatus(
  store: AttentionStore,
  limits: { stuckDays: number; stuckHours: number },
  now = Date.now(),
): AttentionStatus {
  const all = store.items();
  const due = all.filter((i) => isDue(i, limits, now));
  const last = store.meta<{ at: string; errors: string[] }>("lastCheck");
  return {
    checkedAt: last?.at ?? null,
    due,
    watching: all.length - due.length,
    errors: last?.errors ?? [],
    ...limits,
  };
}

const APP_NAMES: Record<string, string> = { sonarr: "Sonarr", radarr: "Radarr" };

/** "A, B, C and 4 more" */
function shortList(parts: string[], max = 4): string {
  if (parts.length <= max) return parts.join(", ");
  return `${parts.slice(0, max).join(", ")} and ${parts.length - max} more`;
}

function byGroup(items: AttentionItem[], noun: [string, string]): string[] {
  const groups = new Map<string, number>();
  for (const i of items) groups.set(i.group, (groups.get(i.group) ?? 0) + 1);
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([group, n]) =>
      items.find((i) => i.group === group)?.app === "sonarr"
        ? `${group} (${n} ${n === 1 ? noun[0] : noun[1]})`
        : group,
    );
}

const clip = (text: string, max = 110) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const days = (n: number) => (n === 1 ? "a day" : `${n} days`);

/** The "Needs a look" lines of the morning summary; none on a quiet day. */
export function summaryLines(status: AttentionStatus): string[] {
  const due = status.due;
  const lines: string[] = [];
  const of = (kind: AttentionItem["kind"]) => due.filter((i) => i.kind === kind);

  const notFound = of("not-found");
  if (notFound.length > 0) {
    lines.push(
      `• Not found or not finished after ${days(status.stuckDays)}: ${shortList(byGroup(notFound, ["episode", "episodes"]))}`,
    );
  }
  const replace = of("replace");
  if (replace.length > 0) {
    lines.push(
      `• Still waiting for a better copy (e.g. not just a dub) after ${days(status.stuckDays)}: ${shortList(byGroup(replace, ["episode", "episodes"]))}`,
    );
  }
  const stalled = of("stalled");
  if (stalled.length > 0) {
    lines.push(
      `• Download stuck for ${days(status.stuckDays)}: ${shortList(
        stalled.map((i) => `${i.what} (${clip(i.detail ?? "", 60)})`),
        3,
      )}`,
    );
  }
  const imports = of("import");
  if (imports.length > 0) {
    lines.push(
      `• Stuck in the download queue for ${status.stuckHours}+ h: ${shortList(
        imports.map((i) => `${i.what} (${APP_NAMES[i.app] ?? i.app}: ${clip(i.detail ?? "", 60)})`),
        3,
      )}`,
    );
  }
  for (const h of of("health")) lines.push(`• ${APP_NAMES[h.app] ?? h.app}: ${clip(h.what)}`);
  for (const s of of("service")) lines.push(`• ${s.what} (${clip(s.detail ?? "", 60)})`);
  if (lines.length === 0) return [];
  return ["Needs a look:", ...lines];
}
