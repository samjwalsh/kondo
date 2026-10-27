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
        ? `${r.series.title} S${String(r.episode.seasonNumber).padStart(2, "0")}E${String(r.episode.episodeNumber).padStart(2, "0")}`
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
