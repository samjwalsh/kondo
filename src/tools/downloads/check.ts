// Finds bad downloads among Sonarr's and Radarr's torrents:
// - fakes, which carry programs (e.g. "NCIS S24E04.exe") instead of a video. Sonarr refuses to
//   import them but doesn't look for another release, so the episode stays missing.
// - stuck downloads, which never get their file list or stop getting further (often a fake swarm
//   with thousands of "peers" and no real seed). Sonarr shows them as downloading forever.
// Either way Sonarr/Radarr are told the grab failed (blocklist + search again), then it's deleted.

import type { JobContext } from "../../server/core/jobs.js";
import type { ArrClient, GrabRecord } from "../../server/integrations/arr.js";
import { errorMessage } from "../../server/integrations/http.js";
import type {
  QbittorrentClient,
  Torrent,
  TorrentFile,
} from "../../server/integrations/qbittorrent.js";
import type { DownloadsMode, ProblemKind } from "./shared.js";
import type { DownloadsStore } from "./store.js";

export const DEFAULT_BLOCKED = ["exe", "scr", "com", "bat", "cmd", "msi", "lnk", "vbs"];

/** Files whose extension is blocked (case-insensitive), whether or not they were downloaded. */
export function blockedFiles(files: TorrentFile[], extensions: string[]): string[] {
  const blocked = new Set(extensions.map((e) => e.replace(/^\*?\./, "").toLowerCase()));
  return files
    .map((f) => f.name.split("/").pop() ?? f.name)
    .filter((name) => {
      const dot = name.lastIndexOf(".");
      return dot > 0 && blocked.has(name.slice(dot + 1).toLowerCase());
    });
}

/** qBittorrent states in which a download is meant to be getting somewhere. */
const ACTIVE = new Set(["downloading", "stalledDL", "forcedDL", "metaDL", "forcedMetaDL"]);
const NO_METADATA = new Set(["metaDL", "forcedMetaDL"]);

export interface StuckRules {
  mode: DownloadsMode;
  /** Running this long without getting the torrent's file list. */
  metadataMinutes: number;
  /** Running this long without downloading another byte. */
  noProgressHours: number;
  /** Never touch private-tracker downloads (hit-and-run rules). */
  leavePrivate: boolean;
}

/** "3 hours", "4 days". */
export function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Why a download counts as stuck, or null. Also records how far it has got, so the next check
 * can tell whether it moved; stopped and queued time doesn't count.
 */
export function stuckReason(
  torrent: Torrent,
  store: Pick<CheckDeps["store"], "progress" | "saveProgress">,
  rules: StuckRules,
  now: number,
): string | null {
  if (torrent.progress >= 1 || !ACTIVE.has(torrent.state)) return null;
  if (NO_METADATA.has(torrent.state)) {
    const active = torrent.timeActive * 1000;
    return active >= rules.metadataMinutes * 60_000 ? `No file list after ${span(active)}` : null;
  }
  const seen = store.progress(torrent.hash);
  if (!seen || seen.downloaded !== torrent.downloaded) {
    store.saveProgress(torrent.hash, torrent.downloaded, new Date(now).toISOString());
    return null;
  }
  const still = now - Date.parse(seen.since);
  if (still < rules.noProgressHours * 3_600_000) return null;
  return `No progress for ${span(still)} at ${Math.floor(torrent.progress * 100)}%`;
}

export interface CheckDeps {
  store: DownloadsStore;
  qbittorrent: Pick<QbittorrentClient, "torrents" | "files" | "deleteWithFiles">;
  arrs: Pick<ArrClient, "app" | "name" | "configured" | "grabOf" | "markFailed">[];
  mode: DownloadsMode;
  categories: string[];
  extensions: string[];
  stuck: StuckRules;
  now?: () => number;
}

export interface CheckResult {
  torrents: number;
  fakes: number;
  stuck: number;
  removed: number;
  failed: number;
  /** Fakes and stuck downloads still in qBittorrent after the check. */
  left: { fakes: number; stuck: number };
}

async function findGrab(
  deps: CheckDeps,
  hash: string,
): Promise<{ arr: CheckDeps["arrs"][number]; grab: GrabRecord } | null> {
  for (const arr of deps.arrs) {
    if (!arr.configured()) continue;
    const grab = await arr.grabOf(hash);
    if (grab) return { arr, grab };
  }
  return null;
}

const NOUN: Record<ProblemKind, string> = { fake: "fake", stuck: "stuck download" };

/** Reports or removes one bad download; true if it was removed. */
async function handle(
  job: JobContext<unknown>,
  deps: CheckDeps,
  torrent: Torrent,
  problem: { kind: ProblemKind; mode: DownloadsMode; badFiles: string[]; why: string | null },
): Promise<boolean> {
  const last = deps.store.last(torrent.hash);
  const found = await findGrab(deps, torrent.hash).catch(() => null);
  const base = {
    hash: torrent.hash,
    name: torrent.name,
    kind: problem.kind,
    app: found?.arr.app ?? null,
    what: found?.grab.what ?? null,
    indexer: found?.grab.indexer ?? null,
    badFiles: problem.badFiles,
    problem: problem.why,
  };
  const what = problem.why ?? problem.badFiles.join(", ");

  if (problem.mode !== "remove") {
    if (last?.action !== "found" || last.kind !== problem.kind) {
      deps.store.log({ ...base, action: "found", detail: null });
      job.log(`${NOUN[problem.kind]}: ${torrent.name} (${what}); report-only, so it's left alone`);
    }
    return false;
  }

  try {
    // Blocklist it first (Sonarr/Radarr then search for another release); only then delete.
    if (found) await found.arr.markFailed(found.grab.id);
    await deps.qbittorrent.deleteWithFiles([torrent.hash]);
    const detail = found
      ? `Marked as failed in ${found.arr.name}, which is looking for another release`
      : "No Sonarr/Radarr record of it, so it was only removed from qBittorrent";
    deps.store.log({ ...base, action: "removed", detail });
    job.log(`Removed ${NOUN[problem.kind]} ${torrent.name} (${what}). ${detail}`);
    return true;
  } catch (error) {
    const detail = `Couldn't remove it: ${errorMessage(error)}`;
    if (last?.action !== "error" || last.detail !== detail) {
      deps.store.log({ ...base, action: "error", detail });
    }
    job.log(`${torrent.name}: ${detail}`, "warn");
    return false;
  }
}

export async function runCheck(job: JobContext<unknown>, deps: CheckDeps): Promise<CheckResult> {
  const now = deps.now ?? Date.now;
  const categories = new Set(deps.categories);
  const torrents = (await deps.qbittorrent.torrents()).filter((t) => categories.has(t.category));
  const result: CheckResult = {
    torrents: torrents.length,
    fakes: 0,
    stuck: 0,
    removed: 0,
    failed: 0,
    left: { fakes: 0, stuck: 0 },
  };
  const count = (kind: ProblemKind, removed: boolean, mode: DownloadsMode) => {
    if (removed) result.removed++;
    else {
      result.left[kind === "fake" ? "fakes" : "stuck"]++;
      if (mode === "remove") result.failed++;
    }
  };

  for (const [i, torrent] of torrents.entries()) {
    await job.checkpoint();
    job.progress(i / torrents.length, `Looking inside ${i + 1} of ${torrents.length}`);

    if (deps.mode !== "off") {
      const bad = blockedFiles(await deps.qbittorrent.files(torrent.hash), deps.extensions);
      if (bad.length > 0) {
        result.fakes++;
        const removed = await handle(job, deps, torrent, {
          kind: "fake",
          mode: deps.mode,
          badFiles: bad,
          why: null,
        });
        count("fake", removed, deps.mode);
        continue;
      }
    }

    if (deps.stuck.mode === "off") continue;
    if (deps.stuck.leavePrivate && torrent.private === true) continue;
    const why = stuckReason(torrent, deps.store, deps.stuck, now());
    if (!why) continue;
    result.stuck++;
    const removed = await handle(job, deps, torrent, {
      kind: "stuck",
      mode: deps.stuck.mode,
      badFiles: [],
      why,
    });
    count("stuck", removed, deps.stuck.mode);
  }

  // Downloads that finished, stopped or went away start their clock again next time.
  deps.store.keepProgress(
    torrents.filter((t) => t.progress < 1 && ACTIVE.has(t.state)).map((t) => t.hash),
  );
  return result;
}
