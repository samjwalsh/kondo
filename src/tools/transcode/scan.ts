import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { JobCancelledError, type JobContext } from "../../server/core/jobs.js";
import type { SettingsStore } from "../../server/core/settings.js";
import type { Integrations } from "../../server/core/tools.js";
import { errorMessage } from "../../server/integrations/http.js";
import { splitLines } from "../../shared/settings.js";
import { languageFromName } from "./languages.js";
import { extractMediaInfo, type Probe } from "./media.js";
import { evaluate, outcomeOverride, type RuleSettings } from "./rules.js";
import type { ArrMatch } from "./shared.js";
import type { FoundFile, LibraryStore } from "./store.js";
import { tempFileId } from "./swap.js";

const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".mov",
  ".wmv",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
  ".webm",
]);
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 120_000;

export interface LibrarySettings {
  roots: string[];
  neverTouch: string[];
  rules: RuleSettings;
}

export function librarySettings(settings: SettingsStore): LibrarySettings {
  const v = settings.values("transcode");
  return {
    roots: splitLines(v.roots).map((r) => path.resolve(r)),
    neverTouch: splitLines(v.neverTouch).map((r) => path.resolve(r)),
    rules: {
      threshold1080Mbps: Number(v.threshold1080Mbps),
      threshold720Mbps: Number(v.threshold720Mbps),
      thresholdSdMbps: Number(v.thresholdSdMbps),
    },
  };
}

/** True for paths inside one of `folders` (or equal to one). */
export function isInside(file: string, folders: string[]): boolean {
  return folders.some((f) => file === f || file.startsWith(`${f}/`));
}

export interface ScanDeps {
  store: LibraryStore;
  settings: SettingsStore;
  integrations: Integrations;
}

export interface ScanResult {
  files: number;
  read: number;
  unreadable: number;
  toTranscode: number;
}

export async function runScan(job: JobContext<unknown>, deps: ScanDeps): Promise<ScanResult> {
  const { roots, neverTouch, rules } = librarySettings(deps.settings);
  if (roots.length === 0) throw new Error("No library folders set yet (Settings → Transcode)");
  for (const root of roots) {
    const ok = await stat(root).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!ok) throw new Error(`Can't read ${root}. Is the media share mounted?`);
  }

  const scanId = deps.store.startScan();
  const seenAt = new Date().toISOString();
  let read = 0;
  let unreadable = 0;
  try {
    // 1. List every video file.
    job.progress(null, "Listing files…");
    const found = new Map<string, FoundFile>();
    const problems: string[] = [];
    const temps: string[] = [];
    for (const root of roots) await walk(root, root, neverTouch, { found, problems, temps }, job);
    for (const p of problems.slice(0, 20)) job.log(p, "warn");
    // Left behind by a swap that was cut short and then abandoned (one in progress is kept).
    for (const temp of temps) {
      const id = tempFileId(path.basename(temp));
      if (id === null || deps.store.outcome(id)?.status === "swapping") continue;
      await rm(temp, { force: true });
      job.log(`Removed a leftover temp file: ${temp}`, "warn");
    }
    const changes = deps.store.reconcile(found, seenAt, problems.length === 0);
    job.log(
      `Found ${found.size} videos (${changes.added} new, ${changes.changed} changed, ${changes.removed} gone)`,
    );

    // 2. Read new and changed files.
    const todo = deps.store.needingProbe();
    const ffprobe = String(deps.settings.values("encoding").ffprobePath);
    await inParallel(todo, PROBE_CONCURRENCY, async (file) => {
      await job.checkpoint();
      const result = await probe(job, ffprobe, file.path);
      deps.store.saveProbe(file.id, result.probe, result.error);
      if (result.error) {
        unreadable++;
        job.log(`Couldn't read ${path.basename(file.path)}: ${result.error}`, "warn");
      }
      read++;
      job.progress(read / todo.length, `Reading files: ${read} / ${todo.length}`);
    });

    // 3. Original languages from Sonarr/Radarr, then decide every file.
    job.progress(null, "Asking Sonarr and Radarr for original languages…");
    const arr = await loadArrIndex(deps.integrations, job);
    job.progress(null, "Deciding…");
    const toTranscode = await decideAll(deps.store, arr, rules);

    deps.store.finishScan(scanId, {
      files: found.size,
      probed: read,
      errors: unreadable,
      error: null,
    });
    job.log(`${toTranscode} file(s) to transcode`);
    return { files: found.size, read, unreadable, toTranscode };
  } catch (error) {
    if (error instanceof JobCancelledError) {
      deps.store.discardScan(scanId);
      throw error;
    }
    deps.store.finishScan(scanId, {
      files: 0,
      probed: read,
      errors: unreadable,
      error: errorMessage(error),
    });
    throw error;
  }
}

interface WalkOut {
  found: Map<string, FoundFile>;
  problems: string[];
  /** Kondo's own hidden temp files (`.name.kondo-12.mkv`). */
  temps: string[];
}

async function walk(
  dir: string,
  root: string,
  neverTouch: string[],
  out: WalkOut,
  job: JobContext<unknown>,
): Promise<void> {
  await job.checkpoint();
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    out.problems.push(`Couldn't list ${dir}: ${errorMessage(error)}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Hidden files are skipped; Kondo's own temp files are noted for tidying.
    if (entry.name.startsWith(".")) {
      if (entry.isFile() && tempFileId(entry.name) !== null && !isInside(full, neverTouch)) {
        out.temps.push(full);
      }
      continue;
    }
    if (isInside(full, neverTouch)) continue;
    if (entry.isDirectory()) {
      await walk(full, root, neverTouch, out, job);
    } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      try {
        const s = await stat(full);
        out.found.set(full, { root, size: s.size, mtimeMs: Math.round(s.mtimeMs) });
      } catch (error) {
        out.problems.push(`Couldn't read ${full}: ${errorMessage(error)}`);
      }
    }
  }
}

async function probe(
  job: JobContext<unknown>,
  ffprobe: string,
  file: string,
): Promise<{ probe: Probe | null; error: string | null }> {
  const out: string[] = [];
  try {
    const result = await job.run(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { nice: 10, timeoutMs: PROBE_TIMEOUT_MS, onStdoutLine: (line) => out.push(line) },
    );
    if (result.timedOut) return { probe: null, error: "ffprobe took too long" };
    if (result.code !== 0) {
      return {
        probe: null,
        error: result.stderrTail.at(-1) ?? `ffprobe exited with ${result.code}`,
      };
    }
    return { probe: JSON.parse(out.join("\n")) as Probe, error: null };
  } catch (error) {
    if (error instanceof JobCancelledError) throw error;
    return { probe: null, error: errorMessage(error) };
  }
}

async function inParallel<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

/** Series/movie folder name → match, e.g. "sonarr:NCIS" → { title, original language }. */
export type ArrIndex = Map<string, ArrMatch>;

interface ArrItem {
  id: number;
  title: string;
  path: string;
  originalLanguage?: { name?: string };
}

async function loadArrIndex(
  integrations: Integrations,
  job: JobContext<unknown>,
): Promise<ArrIndex> {
  const index: ArrIndex = new Map();
  for (const [client, endpoint] of [
    [integrations.sonarr, "/series"],
    [integrations.radarr, "/movie"],
  ] as const) {
    if (!client.configured()) {
      job.log(
        `${client.name} isn't set up, so original languages are unknown for its titles`,
        "warn",
      );
      continue;
    }
    try {
      for (const item of await client.get<ArrItem[]>(endpoint)) {
        index.set(`${client.app}:${path.basename(item.path)}`, {
          app: client.app,
          id: item.id,
          title: item.title,
          originalLanguage: languageFromName(item.originalLanguage?.name),
        });
      }
    } catch (error) {
      job.log(`Couldn't get titles from ${client.name}: ${errorMessage(error)}`, "warn");
    }
  }
  return index;
}

/** The series/movie a file belongs to, by the folder directly under its library folder. */
export function matchArr(file: string, root: string, index: ArrIndex): ArrMatch | null {
  const relative = path.relative(root, file);
  const folder = relative.split(path.sep)[0];
  if (!folder || folder === relative) return null;
  return index.get(`sonarr:${folder}`) ?? index.get(`radarr:${folder}`) ?? null;
}

/** Re-decides every file that has been read. Returns how many are to be transcoded. */
export async function decideAll(
  store: LibraryStore,
  arr: ArrIndex,
  rules: RuleSettings,
): Promise<number> {
  const rows = store.forDecision();
  let toTranscode = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((row) => {
      const match = matchArr(row.path, row.root, arr);
      const info = row.probe ? extractMediaInfo(row.probe) : null;
      // A remembered result (not worth it, rejected, failed twice) wins over the rules.
      const evaluation =
        outcomeOverride(row.outcome) ?? evaluate(info, match?.originalLanguage ?? null, rules);
      if (evaluation.decision === "transcode") toTranscode++;
      return { id: row.id, evaluation, arr: match, probe: row.probe };
    });
    store.saveDecisions(batch);
    // Let the web server breathe between batches.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return toTranscode;
}
