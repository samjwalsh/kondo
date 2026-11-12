// Emails the person who requested a film or show once they can start watching it.
//
// Seerr's own "Request Available" email only goes out when *every* requested season is complete,
// and a season counts as complete only when Plex has as many episodes as TMDB lists, including
// ones not aired yet. Someone who asks for a show mid-season hears nothing until the finale.
// Here a film is ready once it's in Plex, and a show once the first requested season has its
// first episode in Plex.
//
// The first check only records what is already ready, so switching this on doesn't email
// everyone about old requests.

import type { Email } from "../../server/integrations/email.js";
import { errorMessage } from "../../server/integrations/http.js";
import type { PlexClient } from "../../server/integrations/plex.js";
import {
  MEDIA_AVAILABLE,
  MEDIA_PARTIALLY_AVAILABLE,
  REQUEST_APPROVED,
  REQUEST_COMPLETED,
  type SeerrClient,
  type SeerrRequest,
  type SeerrTitle,
} from "../../server/integrations/seerr.js";
import { buildMessage, firstName, type ReadyInfo, seasonDetail } from "./message.js";
import type { Notice } from "./shared.js";
import type { RequestsStore } from "./store.js";

/** Failed emails are retried on later checks, up to this many tries in all. */
export const MAX_ATTEMPTS = 5;

export interface CheckDeps {
  store: RequestsStore;
  seerr: Pick<SeerrClient, "requests" | "title" | "userEmail" | "main">;
  plex: Pick<PlexClient, "configured" | "episodeNumbers">;
  email: Pick<Email, "send">;
  now?: () => number;
}

export interface CheckResult {
  sent: number;
  failed: number;
  /** Ready before Kondo started watching (first check only). */
  before: number;
  waiting: number;
  errors: string[];
}

/** The season a show request is "ready" by: the lowest requested, specials only if alone. */
export function firstSeason(request: SeerrRequest): number | null {
  const numbers = (request.seasons ?? []).map((s) => s.seasonNumber).sort((a, b) => a - b);
  return numbers.find((n) => n > 0) ?? numbers[0] ?? null;
}

/** Cheap pre-check from the request list alone, before fetching any details. */
function mightBeReady(r: SeerrRequest): boolean {
  if (r.status !== REQUEST_APPROVED && r.status !== REQUEST_COMPLETED) return false;
  if (r.is4k) return false;
  return r.type === "movie"
    ? r.media.status === MEDIA_AVAILABLE
    : r.media.status === MEDIA_PARTIALLY_AVAILABLE || r.media.status === MEDIA_AVAILABLE;
}

/** What's ready to watch for this request, or null if nothing is yet. */
export async function readiness(
  r: SeerrRequest,
  title: SeerrTitle,
  plex: CheckDeps["plex"],
): Promise<ReadyInfo | null> {
  const base = {
    type: r.type,
    title: title.title,
    year: title.year,
    posterPath: title.posterPath,
  };
  if (!title.media) return null;
  if (r.type === "movie") return title.media.status === MEDIA_AVAILABLE ? base : null;

  const number = firstSeason(r);
  if (number === null) return null;
  const status = title.media.seasons.find((s) => s.seasonNumber === number)?.status;
  const total = title.episodeCounts.get(number) ?? 0;
  const moreSeasons = (r.seasons ?? []).length > 1;
  if (status === MEDIA_AVAILABLE) {
    return { ...base, moreSeasons, season: { number, have: total, total, complete: true } };
  }
  if (status !== MEDIA_PARTIALLY_AVAILABLE) return null;
  // Partly there: only ready if episode 1 is, so they can start from the beginning.
  if (!plex.configured() || !title.media.ratingKey) {
    return { ...base, moreSeasons, season: { number, have: null, total, complete: false } };
  }
  const episodes = await plex.episodeNumbers(title.media.ratingKey, number);
  if (!episodes?.includes(1)) return null;
  return {
    ...base,
    moreSeasons,
    season: { number, have: episodes.length, total, complete: false },
  };
}

export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
  const now = deps.now ?? Date.now;
  const { store } = deps;
  const result: CheckResult = { sent: 0, failed: 0, before: 0, waiting: 0, errors: [] };
  const firstCheck = store.meta("startedAt") === null;

  let requests: SeerrRequest[];
  try {
    requests = await deps.seerr.requests();
  } catch (error) {
    const message = `Couldn't list Seerr's requests: ${errorMessage(error)}`;
    store.setMeta("lastError", message);
    throw new Error(message);
  }

  const done = store.done(MAX_ATTEMPTS);
  const open = requests.filter(
    (r) =>
      (r.status === REQUEST_APPROVED || r.status === REQUEST_COMPLETED) &&
      !r.is4k &&
      !done.has(r.id),
  );
  const titles = new Map<string, Promise<SeerrTitle>>();
  let main: Awaited<ReturnType<CheckDeps["seerr"]["main"]>> | null = null;

  for (const r of open) {
    if (!mightBeReady(r)) {
      result.waiting++;
      continue;
    }
    let info: ReadyInfo | null;
    try {
      const key = `${r.type}:${r.media.tmdbId}`;
      if (!titles.has(key)) titles.set(key, deps.seerr.title(r.type, r.media.tmdbId));
      const title = await (titles.get(key) as Promise<SeerrTitle>);
      info = await readiness(r, title, deps.plex);
      if (!info) {
        result.waiting++;
        continue;
      }
      const at = new Date(now()).toISOString();
      const previous = store.get(r.id);
      const notice: Notice = {
        requestId: r.id,
        at,
        status: "before",
        type: r.type,
        title: info.title,
        detail: seasonDetail(info),
        user: r.requestedBy.displayName || `User ${r.requestedBy.id}`,
        attempts: previous?.attempts ?? 0,
        error: null,
      };
      if (firstCheck) {
        store.save(notice);
        result.before++;
        continue;
      }

      const to = r.requestedBy.email || (await deps.seerr.userEmail(r.requestedBy.id));
      if (!to?.includes("@")) {
        store.save({ ...notice, status: "skipped", error: "No email address in Seerr" });
        continue;
      }
      main ??= await deps.seerr.main();
      const plexUrl = title.media?.plexUrl ?? null;
      const message = buildMessage(info, {
        userName: firstName(notice.user),
        plexUrl,
        seerrUrl: main.applicationUrl ? `${main.applicationUrl}/${r.type}/${r.media.tmdbId}` : null,
        appTitle: main.applicationTitle,
      });
      try {
        await deps.email.send({
          to,
          ...message,
          // Same key if Kondo stops between sending and saving, so Resend won't send it twice.
          idempotencyKey: `kondo-request-${r.id}-${notice.attempts + 1}`,
        });
        store.save({ ...notice, status: "sent", attempts: notice.attempts + 1 });
        result.sent++;
      } catch (error) {
        store.save({
          ...notice,
          status: "failed",
          attempts: notice.attempts + 1,
          error: errorMessage(error),
        });
        result.failed++;
        result.errors.push(`${info.title}: ${errorMessage(error)}`);
      }
    } catch (error) {
      result.errors.push(`Request ${r.id}: ${errorMessage(error)}`);
    }
  }

  if (firstCheck) store.setMeta("startedAt", new Date(now()).toISOString());
  store.setMeta("checkedAt", new Date(now()).toISOString());
  store.setMeta("lastError", result.errors.length > 0 ? result.errors.join("; ") : null);
  store.setMeta("waiting", String(result.waiting));
  return result;
}
