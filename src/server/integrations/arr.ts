import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, request, requestJson } from "./http.js";

export type ArrApp = "sonarr" | "radarr";

const NAMES: Record<ArrApp, string> = { sonarr: "Sonarr", radarr: "Radarr" };

export function arrSettings(app: ArrApp): SettingsSection {
  const name = NAMES[app];
  return {
    scope: app,
    title: name,
    group: "integration",
    description: `Kondo asks ${name} for each title's original language and tells it to rescan after a file is replaced.`,
    testable: true,
    fields: [
      {
        key: "url",
        label: "Address",
        type: "url",
        placeholder: app === "sonarr" ? "http://sonarr:8989" : "http://radarr:7878",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "secret",
        help: `${name} → Settings → General → Security → API Key.`,
      },
    ],
  };
}

interface RawHistory {
  id: number;
  sourceTitle: string;
  data?: { indexer?: string };
  series?: { title: string };
  episode?: { seasonNumber: number; episodeNumber: number };
  movie?: { title: string };
}

export interface GrabRecord {
  id: number;
  /** The release name as grabbed. */
  sourceTitle: string;
  /** e.g. "NCIS S24E04" or a movie title. */
  what: string;
  indexer: string | null;
}

/** A monitored episode or movie that has no file yet. */
export interface MissingItem {
  /** Episode id (Sonarr) or movie id (Radarr). */
  id: number;
  /** e.g. "NCIS S24E04" or "Wind River (2017)". */
  what: string;
  /** The series or movie it belongs to, e.g. "NCIS" or "Wind River (2017)". */
  title: string;
  /** When Sonarr/Radarr last searched for it, if ever. */
  lastSearchTime: string | null;
}

interface RawMissing {
  id: number;
  title?: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  series?: { title: string };
  lastSearchTime?: string | null;
  /** Radarr: released enough for its minimum availability. */
  isAvailable?: boolean;
}

/** A download Sonarr/Radarr can't finish on their own. */
export interface QueueProblem {
  /** Queue item id. */
  id: number;
  /** e.g. "NCIS S24E04" or "Wind River (2017)". */
  what: string;
  /** The release name. */
  release: string;
  problem: string;
}

interface RawQueue {
  id: number;
  title?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  errorMessage?: string;
  series?: { title: string };
  episode?: { seasonNumber: number; episodeNumber: number };
  movie?: { title: string; year?: number };
}

interface RawProfile {
  id: number;
  upgradeAllowed: boolean;
  cutoffFormatScore: number;
  formatItems: { score: number }[];
}

interface RawFile {
  id: number;
  customFormatScore?: number;
  customFormats?: { name: string }[];
}

interface RawSeries {
  id: number;
  title: string;
  monitored: boolean;
  qualityProfileId: number;
}

interface RawEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  monitored: boolean;
  episodeFileId?: number;
  lastSearchTime?: string | null;
}

interface RawMovie {
  id: number;
  title: string;
  year?: number;
  monitored: boolean;
  hasFile?: boolean;
  qualityProfileId: number;
}

const episodeName = (series: string, season: number, episode: number) =>
  `${series} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

export class ArrClient {
  constructor(
    readonly app: ArrApp,
    private readonly settings: SettingsStore,
  ) {}

  get name(): string {
    return NAMES[this.app];
  }

  configured(): boolean {
    return this.settings.hasValues(this.app, ["url", "apiKey"]);
  }

  async get<T>(path: string): Promise<T> {
    return requestJson<T>(this.url(path), { headers: this.headers() });
  }

  /** POSTs JSON; an empty reply (some endpoints send none) comes back as null. */
  async post<T>(path: string, body: unknown): Promise<T | null> {
    const response = await request(this.url(path), {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return text.trim() === "" ? null : (JSON.parse(text) as T);
  }

  /** Asks Sonarr to rescan a series (or Radarr a movie) so it picks up a replaced file. */
  async rescan(id: number): Promise<void> {
    await this.post(
      "/command",
      this.app === "sonarr"
        ? { name: "RescanSeries", seriesId: id }
        : { name: "RescanMovie", movieId: id },
    );
  }

  /** The record of when a download was grabbed, by the download client's id (torrent hash). */
  async grabOf(downloadId: string): Promise<GrabRecord | null> {
    const page = await this.get<{ records?: RawHistory[] }>(
      `/history?downloadId=${encodeURIComponent(downloadId.toUpperCase())}&eventType=1&pageSize=5&${
        this.app === "sonarr" ? "includeSeries=true&includeEpisode=true" : "includeMovie=true"
      }`,
    );
    const r = page.records?.[0];
    if (!r) return null;
    const episode =
      r.episode && r.series
        ? episodeName(r.series.title, r.episode.seasonNumber, r.episode.episodeNumber)
        : null;
    return {
      id: r.id,
      sourceTitle: r.sourceTitle,
      what: episode ?? r.movie?.title ?? r.series?.title ?? r.sourceTitle,
      indexer: r.data?.indexer ?? null,
    };
  }

  /**
   * Marks a grabbed download as failed: the release is blocklisted and, with "Redownload Failed"
   * on, Sonarr/Radarr look for another one straight away.
   */
  async markFailed(historyId: number): Promise<void> {
    await this.post(`/history/failed/${historyId}`, {});
  }

  /**
   * Monitored episodes (already aired) or movies (already available) with no file. Sonarr and
   * Radarr only search for these when told to; otherwise they wait for new releases.
   */
  async missing(): Promise<MissingItem[]> {
    const items: MissingItem[] = [];
    for (let page = 1; ; page++) {
      const result = await this.get<{ records?: RawMissing[]; totalRecords?: number }>(
        `/wanted/missing?page=${page}&pageSize=500&monitored=true${
          this.app === "sonarr" ? "&includeSeries=true" : ""
        }`,
      );
      const records = result.records ?? [];
      for (const r of records) {
        if (this.app === "radarr" && r.isAvailable === false) continue;
        const movie = `${r.title ?? `#${r.id}`}${r.year ? ` (${r.year})` : ""}`;
        items.push({
          id: r.id,
          what:
            this.app === "sonarr" && r.series
              ? episodeName(r.series.title, r.seasonNumber ?? 0, r.episodeNumber ?? 0)
              : movie,
          title: this.app === "sonarr" && r.series ? r.series.title : movie,
          lastSearchTime: r.lastSearchTime ?? null,
        });
      }
      if (records.length === 0 || page * 500 >= (result.totalRecords ?? 0)) return items;
    }
  }

  /**
   * Monitored episodes or movies whose file scores below its profile's "upgrade until" custom
   * format score, in profiles that allow upgrades: files Sonarr/Radarr would replace with a better
   * release, e.g. one with only a dub. Their own Cutoff Unmet list counts only quality, so
   * nothing searches for these once the file is in.
   */
  async belowFormatCutoff(): Promise<MissingItem[]> {
    const profiles = new Map(
      (await this.get<RawProfile[]>("/qualityprofile"))
        .filter((p) => p.upgradeAllowed && p.formatItems.some((f) => f.score !== 0))
        .map((p) => [p.id, p.cutoffFormatScore]),
    );
    if (profiles.size === 0) return [];
    const below = (file: RawFile | undefined, profileId: number) => {
      const cutoff = profiles.get(profileId);
      return (
        file !== undefined &&
        cutoff !== undefined &&
        typeof file.customFormatScore === "number" &&
        file.customFormatScore < cutoff
      );
    };
    const why = (file: RawFile) => {
      const names = (file.customFormats ?? []).map((f) => f.name).filter(Boolean);
      return names.length > 0 ? ` (${names.join(", ")})` : "";
    };
    const items: MissingItem[] = [];
    if (this.app === "radarr") {
      // The movie list leaves out the file's score: ask for the files, 100 movies at a time.
      const movies = (await this.get<RawMovie[]>("/movie")).filter(
        (m) => m.monitored && m.hasFile && profiles.has(m.qualityProfileId),
      );
      for (let i = 0; i < movies.length; i += 100) {
        const batch = new Map(movies.slice(i, i + 100).map((m) => [m.id, m]));
        const query = [...batch.keys()].map((id) => `movieId=${id}`).join("&");
        for (const file of await this.get<(RawFile & { movieId: number })[]>(
          `/moviefile?${query}`,
        )) {
          const m = batch.get(file.movieId);
          if (!m || !below(file, m.qualityProfileId)) continue;
          const title = `${m.title}${m.year ? ` (${m.year})` : ""}`;
          items.push({
            id: m.id,
            what: `${title}${why(file)}`,
            title,
            // Radarr's movie list doesn't say; the Missing tool remembers its own searches.
            lastSearchTime: null,
          });
        }
      }
      return items;
    }
    for (const series of await this.get<RawSeries[]>("/series")) {
      if (!series.monitored || !profiles.has(series.qualityProfileId)) continue;
      const files = new Map(
        (await this.get<RawFile[]>(`/episodefile?seriesId=${series.id}`))
          .filter((f) => below(f, series.qualityProfileId))
          .map((f) => [f.id, f]),
      );
      if (files.size === 0) continue;
      for (const e of await this.get<RawEpisode[]>(`/episode?seriesId=${series.id}`)) {
        const file = e.episodeFileId ? files.get(e.episodeFileId) : undefined;
        if (!file || !e.monitored) continue;
        items.push({
          id: e.id,
          what: `${episodeName(series.title, e.seasonNumber, e.episodeNumber)}${why(file)}`,
          title: series.title,
          lastSearchTime: e.lastSearchTime ?? null,
        });
      }
    }
    return items;
  }

  /**
   * Downloads Sonarr/Radarr can't finish on their own: import blocked or pending, or flagged with
   * a warning or error (e.g. "Unable to match", "manual import required").
   */
  async queueProblems(): Promise<QueueProblem[]> {
    const page = await this.get<{ records?: RawQueue[] }>(
      `/queue?pageSize=1000&includeUnknownSeriesItems=true&${
        this.app === "sonarr" ? "includeSeries=true&includeEpisode=true" : "includeMovie=true"
      }`,
    );
    const out: QueueProblem[] = [];
    for (const r of page.records ?? []) {
      const state = r.trackedDownloadState ?? "";
      const flagged = r.trackedDownloadStatus === "warning" || r.trackedDownloadStatus === "error";
      if (!flagged && !["importBlocked", "importPending", "failedPending"].includes(state))
        continue;
      const messages = (r.statusMessages ?? []).flatMap((m) => m.messages ?? []);
      const what =
        r.series && r.episode
          ? episodeName(r.series.title, r.episode.seasonNumber, r.episode.episodeNumber)
          : r.movie
            ? `${r.movie.title}${r.movie.year ? ` (${r.movie.year})` : ""}`
            : (r.title ?? `#${r.id}`);
      out.push({
        id: r.id,
        what,
        release: r.title ?? "",
        problem: messages[0] ?? r.errorMessage ?? state,
      });
    }
    return out;
  }

  /** Sonarr/Radarr's own health warnings and errors (System → Status). */
  async healthIssues(): Promise<{ source: string; message: string }[]> {
    return (await this.get<{ source: string; type: string; message: string }[]>("/health"))
      .filter((h) => h.type === "warning" || h.type === "error")
      .map(({ source, message }) => ({ source, message }));
  }

  /** Episode (Sonarr) or movie (Radarr) ids that already have a download in the queue. */
  async queuedIds(): Promise<Set<number>> {
    const page = await this.get<{ records?: { episodeId?: number; movieId?: number }[] }>(
      "/queue?pageSize=1000",
    );
    const ids = (page.records ?? []).map((r) => (this.app === "sonarr" ? r.episodeId : r.movieId));
    return new Set(ids.filter((id): id is number => typeof id === "number"));
  }

  /** Searches every indexer for these episodes (Sonarr) or movies (Radarr). */
  async search(ids: number[]): Promise<void> {
    await this.post(
      "/command",
      this.app === "sonarr"
        ? { name: "EpisodeSearch", episodeIds: ids }
        : { name: "MoviesSearch", movieIds: ids },
    );
  }

  private url(path: string): string {
    return `${String(this.settings.values(this.app).url).replace(/\/+$/, "")}/api/v3${path}`;
  }

  private headers(): Record<string, string> {
    return { "X-Api-Key": this.settings.secret(this.app, "apiKey") ?? "" };
  }

  async version(): Promise<string> {
    const status = await this.get<{ version?: string }>("/system/status");
    return status.version ?? "unknown";
  }

  async test(): Promise<TestResult> {
    if (!this.configured()) return { ok: false, message: "Fill in the address and API key first." };
    try {
      return { ok: true, message: `Connected to ${this.name} ${await this.version()}.` };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }
}
