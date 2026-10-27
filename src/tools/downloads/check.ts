// Finds fake releases among Sonarr's and Radarr's downloads: torrents that carry programs
// (e.g. "NCIS S24E04.exe") instead of a video. Sonarr refuses to import them but doesn't look
// for another release, so the episode stays missing while the fake keeps seeding.

import type { JobContext } from "../../server/core/jobs.js";
import type { ArrClient, GrabRecord } from "../../server/integrations/arr.js";
import { errorMessage } from "../../server/integrations/http.js";
import type { QbittorrentClient, TorrentFile } from "../../server/integrations/qbittorrent.js";
import type { DownloadsMode } from "./shared.js";
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

export interface CheckDeps {
  store: DownloadsStore;
  qbittorrent: Pick<QbittorrentClient, "torrents" | "files" | "deleteWithFiles">;
  arrs: Pick<ArrClient, "app" | "name" | "configured" | "grabOf" | "markFailed">[];
  mode: DownloadsMode;
  categories: string[];
  extensions: string[];
}

export interface CheckResult {
  torrents: number;
  fakes: number;
  removed: number;
  failed: number;
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

export async function runCheck(job: JobContext<unknown>, deps: CheckDeps): Promise<CheckResult> {
  const categories = new Set(deps.categories);
  const torrents = (await deps.qbittorrent.torrents()).filter((t) => categories.has(t.category));
  const result: CheckResult = { torrents: torrents.length, fakes: 0, removed: 0, failed: 0 };

  for (const [i, torrent] of torrents.entries()) {
    await job.checkpoint();
    job.progress(i / torrents.length, `Looking inside ${i + 1} of ${torrents.length}`);
    const bad = blockedFiles(await deps.qbittorrent.files(torrent.hash), deps.extensions);
    if (bad.length === 0) continue;
    result.fakes++;

    const last = deps.store.last(torrent.hash);
    const found = await findGrab(deps, torrent.hash).catch(() => null);
    const base = {
      hash: torrent.hash,
      name: torrent.name,
      app: found?.arr.app ?? null,
      what: found?.grab.what ?? null,
      indexer: found?.grab.indexer ?? null,
      badFiles: bad,
    };

    if (deps.mode !== "remove") {
      if (last?.action !== "found") {
        deps.store.log({ ...base, action: "found", detail: null });
        job.log(`Fake: ${torrent.name} (${bad.join(", ")}); report-only, so it's left alone`);
      }
      continue;
    }

    try {
      // Blocklist it first (Sonarr/Radarr then search for another release); only then delete.
      if (found) await found.arr.markFailed(found.grab.id);
      await deps.qbittorrent.deleteWithFiles([torrent.hash]);
      const detail = found
        ? `Marked as failed in ${found.arr.name}, which is looking for another release`
        : "No Sonarr/Radarr record of it, so it was only removed from qBittorrent";
      deps.store.log({ ...base, action: "removed", detail });
      job.log(`Removed fake ${torrent.name}. ${detail}`);
      result.removed++;
    } catch (error) {
      const detail = `Couldn't remove it: ${errorMessage(error)}`;
      if (last?.action !== "error" || last.detail !== detail) {
        deps.store.log({ ...base, action: "error", detail });
      }
      job.log(`${torrent.name}: ${detail}`, "warn");
      result.failed++;
    }
  }
  return result;
}
