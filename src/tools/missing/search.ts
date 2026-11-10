// Sonarr and Radarr only search for a missing episode or movie when it's added, when a download
// fails, or when someone clicks Search; after that they just watch their indexers' feeds of new
// releases. A release that was already out (and missed) is never found again. This asks them to
// search for a few missing items per run, the ones searched longest ago (or never) first, so
// every missing item gets a turn without hammering the indexers.
//
// The same goes for a file Sonarr/Radarr would replace because of its custom formats (e.g. one
// with only a dub): their Cutoff Unmet list only counts quality, so nothing searches for a
// better release. Those take turns with the missing items.

import type { JobContext } from "../../server/core/jobs.js";
import type { ArrClient, MissingItem } from "../../server/integrations/arr.js";
import { errorMessage } from "../../server/integrations/http.js";
import type { MissingStore } from "./store.js";

export interface SearchDeps {
  store: MissingStore;
  arrs: Pick<
    ArrClient,
    "app" | "name" | "configured" | "missing" | "belowFormatCutoff" | "queuedIds" | "search"
  >[];
  perRun: number;
  /** Also search for files below their custom format cutoff. */
  upgrades: boolean;
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

/** Each item's later of Sonarr/Radarr's last search and Kondo's own. */
export function withOwnSearches(items: MissingItem[], own: Map<number, string>): MissingItem[] {
  return items.map((item) => {
    const mine = own.get(item.id);
    if (!mine) return item;
    const theirs = item.lastSearchTime;
    return theirs && Date.parse(theirs) >= Date.parse(mine)
      ? item
      : { ...item, lastSearchTime: mine };
  });
}

export interface SearchResult {
  searched: number;
  missing: number;
  upgrades: number;
  failed: number;
}

export async function runSearch(job: JobContext<unknown>, deps: SearchDeps): Promise<SearchResult> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const result: SearchResult = { searched: 0, missing: 0, upgrades: 0, failed: 0 };
  for (const arr of deps.arrs) {
    if (!arr.configured()) continue;
    await job.checkpoint();
    try {
      const queued = await arr.queuedIds();
      const missing = (await arr.missing()).filter((item) => !queued.has(item.id));
      const upgrades = deps.upgrades
        ? (await arr.belowFormatCutoff()).filter((item) => !queued.has(item.id))
        : [];
      const picked = pickItems(
        withOwnSearches([...missing, ...upgrades], deps.store.searchedAt(arr.app)),
        queued,
        deps.perRun,
      );
      if (picked.length > 0) {
        await arr.search(picked.map((item) => item.id));
        deps.store.markSearched(
          arr.app,
          picked.map((item) => item.id),
          at,
        );
      }
      deps.store.log({
        at,
        app: arr.app,
        missing: missing.length,
        upgrades: upgrades.length,
        searched: picked.map((item) => item.what),
        error: null,
      });
      job.log(
        `${arr.name}: ${missing.length} missing, ${upgrades.length} to replace, asked to search for ${picked.length}`,
      );
      result.searched += picked.length;
      result.missing += missing.length;
      result.upgrades += upgrades.length;
    } catch (error) {
      deps.store.log({
        at,
        app: arr.app,
        missing: 0,
        upgrades: 0,
        searched: [],
        error: errorMessage(error),
      });
      job.log(`${arr.name}: ${errorMessage(error)}`, "warn");
      result.failed++;
    }
  }
  deps.store.saveLastRunAt(at);
  return result;
}
