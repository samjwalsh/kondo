// One-off tidy of Squish's leftovers: `Show S01E01 [SQUISH].mkv` → `Show S01E01.mkv`, and the
// same for its subtitles and anything else Squish renamed. Renames only; contents never change.

import type { Dirent } from "node:fs";
import { lstat, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { JobContext } from "../../server/core/jobs.js";
import type { Lock } from "../../server/core/lock.js";
import type { SettingsStore } from "../../server/core/settings.js";
import { errorMessage } from "../../server/integrations/http.js";
import { isInside, librarySettings, VIDEO_EXTENSIONS } from "./scan.js";
import type { ArrMatch, SquishStatus } from "./shared.js";
import type { LibraryStore } from "./store.js";

const TAG = " [SQUISH]";

/** The name without Squish's tag, or null if it hasn't got one. */
export function squishTarget(name: string): string | null {
  return name.includes(TAG) ? name.replace(TAG, "") : null;
}

/** The series/movie folder a file belongs to: the folder directly under its library folder. */
export function titleOf(file: string, root: string): string {
  const relative = path.relative(root, file);
  const top = relative.split(path.sep)[0] ?? "";
  return relative.includes(path.sep) ? path.join(root, top) : root;
}

export interface SquishDeps {
  store: LibraryStore;
  settings: SettingsStore;
  /** Shared with scans and swaps, so they never see a title half-renamed. */
  lock: Lock;
  isPlaying: (file: string) => boolean;
  /** Tells Plex and Sonarr/Radarr to look again; returns lines for the job log. */
  rescan: (arr: ArrMatch | null, folder: string) => Promise<string[]>;
  /** Breathing room for Sonarr/Radarr between titles. */
  pauseMs?: number;
}

export interface SquishCheckResult {
  files: number;
  clashes: number;
  titles: number;
}

/** Lists every file with Squish's tag, and whether its plain name is free. */
export async function runSquishCheck(
  job: JobContext<unknown>,
  deps: SquishDeps,
): Promise<SquishCheckResult> {
  const { roots, neverTouch } = librarySettings(deps.settings);
  if (roots.length === 0) throw new Error("No library folders set yet (Settings → Transcode)");
  return deps.lock.run(async () => {
    job.progress(null, "Looking for [SQUISH] names…");
    const items: { path: string; title: string; target: string; status: SquishStatus }[] = [];
    const walk = async (dir: string, root: string): Promise<void> => {
      await job.checkpoint();
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        job.log(`Couldn't list ${dir}: ${errorMessage(error)}`, "warn");
        return;
      }
      const names = new Set(entries.map((e) => e.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (isInside(full, neverTouch)) continue;
        if (entry.isDirectory()) {
          await walk(full, root);
        } else if (entry.isFile()) {
          const target = squishTarget(entry.name);
          if (!target) continue;
          items.push({
            path: full,
            title: titleOf(full, root),
            target,
            status: names.has(target) ? "clash" : "pending",
          });
        }
      }
    };
    for (const root of roots) await walk(root, root);
    deps.store.saveSquishPlan(items, new Date().toISOString());
    const clashes = items.filter((i) => i.status === "clash").length;
    const titles = new Set(items.map((i) => i.title)).size;
    job.log(
      `${items.length} file(s) in ${titles} title(s) still named [SQUISH]; ${clashes} can't be renamed because the plain name is taken`,
    );
    return { files: items.length, clashes, titles };
  }, job.signal);
}

export interface SquishRenamePayload {
  /** One title's folder, or every title still to do. */
  title?: string;
}

export interface SquishRenameResult {
  renamed: number;
  clashes: number;
  failed: number;
  /** Titles left for later because someone was watching. */
  watched: number;
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** Renames title by title, asking for rescans after each so nothing ever looks missing for long. */
export async function runSquishRename(
  job: JobContext<SquishRenamePayload>,
  deps: SquishDeps,
): Promise<SquishRenameResult> {
  const titles = job.payload.title ? [job.payload.title] : deps.store.squishTitlesToDo();
  const total: SquishRenameResult = { renamed: 0, clashes: 0, failed: 0, watched: 0 };
  for (const [i, title] of titles.entries()) {
    await job.checkpoint();
    const name = path.basename(title);
    job.progress(i / titles.length, `${name} (${i + 1} of ${titles.length})`);
    const result = await deps.lock.run(() => renameTitle(deps, title), job.signal);
    if (result.watched) {
      total.watched++;
      job.log(`${name}: someone is watching it (or Plex can't be asked), so it's left for later`);
      continue;
    }
    total.renamed += result.renamed;
    total.clashes += result.clashes;
    total.failed += result.failed;
    for (const problem of result.problems) job.log(`${name}: ${problem}`, "warn");
    if (result.renamed === 0) continue;
    job.log(`${name}: renamed ${result.renamed} file(s)`);
    try {
      for (const line of await deps.rescan(result.arr, title)) job.log(`${name}: ${line}`);
    } catch (error) {
      job.log(`${name}: couldn't ask for a rescan: ${errorMessage(error)}`, "warn");
    }
    if (deps.pauseMs && i < titles.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, deps.pauseMs));
    }
  }
  job.log(
    `Renamed ${total.renamed} file(s)` +
      (total.clashes ? `; ${total.clashes} left because the plain name is taken` : "") +
      (total.failed ? `; ${total.failed} failed` : "") +
      (total.watched ? `; ${total.watched} title(s) left for later (being watched)` : ""),
  );
  return total;
}

async function renameTitle(
  deps: SquishDeps,
  title: string,
): Promise<{
  renamed: number;
  clashes: number;
  failed: number;
  watched: boolean;
  arr: ArrMatch | null;
  problems: string[];
}> {
  const { store } = deps;
  const items = store
    .squishItems(title)
    .filter((item) => item.status === "pending" || item.status === "error");
  const isVideo = (file: string) => VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase());
  const out = {
    renamed: 0,
    clashes: 0,
    failed: 0,
    watched: false,
    arr: null as ArrMatch | null,
    problems: [] as string[],
  };
  if (items.some((item) => isVideo(item.fullPath) && deps.isPlaying(item.fullPath))) {
    out.watched = true;
    return out;
  }
  for (const item of items) {
    const from = item.fullPath;
    const to = path.join(path.dirname(from), item.target);
    if (!(await exists(from))) {
      store.setSquishStatus(from, "gone");
      continue;
    }
    if (await exists(to)) {
      store.setSquishStatus(from, "clash");
      out.clashes++;
      out.problems.push(`${item.target} already exists, so ${item.path} is left as it is`);
      continue;
    }
    try {
      await rename(from, to);
      store.setSquishStatus(from, "done");
      out.renamed++;
      if (isVideo(from)) out.arr = store.renamedVideo(from, to) ?? out.arr;
    } catch (error) {
      store.setSquishStatus(from, "error", errorMessage(error));
      out.failed++;
      out.problems.push(`couldn't rename ${item.path}: ${errorMessage(error)}`);
    }
  }
  return out;
}
