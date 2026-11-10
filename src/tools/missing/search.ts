// Sonarr and Radarr only search for a missing episode or movie when it's added, when a download
// fails, or when someone clicks Search; after that they just watch their indexers' feeds of new
// releases. A release that was already out (and missed) is never found again. This asks them to
// search for a few missing items per run, the ones searched longest ago (or never) first, so
// every missing item gets a turn without hammering the indexers.

import type { JobContext } from "../../server/core/jobs.js";
import type { ArrClient, MissingItem } from "../../server/integrations/arr.js";
import { errorMessage } from "../../server/integrations/http.js";
import type { MissingStore } from "./store.js";

export interface SearchDeps {
  store: MissingStore;
  arrs: Pick<ArrClient, "app" | "name" | "configured" | "missing" | "queuedIds" | "search">[];
  perRun: number;
  now?: () => number;
}

/** Missing items not already downloading, searched longest ago (never-searched first). */
export function pickItems(items: MissingItem[], queued: Set<number>, limit: number): MissingItem[] {
  const time = (item: MissingItem) => (item.lastSearchTime ? Date.parse(item.lastSearchTime) : 0);
  return items
    .filter((item) => !queued.has(item.id))
    .sort((a, b) => time(a) - time(b))
    .slice(0, limit);
}

export interface SearchResult {
  searched: number;
  missing: number;
  failed: number;
}

export async function runSearch(job: JobContext<unknown>, deps: SearchDeps): Promise<SearchResult> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const result: SearchResult = { searched: 0, missing: 0, failed: 0 };
  for (const arr of deps.arrs) {
    if (!arr.configured()) continue;
    await job.checkpoint();
    try {
      const queued = await arr.queuedIds();
      const missing = (await arr.missing()).filter((item) => !queued.has(item.id));
      const picked = pickItems(missing, queued, deps.perRun);
      if (picked.length > 0) await arr.search(picked.map((item) => item.id));
      deps.store.log({
        at,
        app: arr.app,
        missing: missing.length,
        searched: picked.map((item) => item.what),
        error: null,
      });
      job.log(`${arr.name}: ${missing.length} missing, asked to search for ${picked.length}`);
      result.searched += picked.length;
      result.missing += missing.length;
    } catch (error) {
      deps.store.log({ at, app: arr.app, missing: 0, searched: [], error: errorMessage(error) });
      job.log(`${arr.name}: ${errorMessage(error)}`, "warn");
      result.failed++;
    }
  }
  deps.store.saveLastRunAt(at);
  return result;
}
