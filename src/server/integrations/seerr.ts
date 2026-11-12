import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, requestJson } from "./http.js";

export const seerrSettings: SettingsSection = {
  scope: "seerr",
  title: "Seerr",
  group: "integration",
  description: "Where people request films and shows (Seerr, Overseerr or Jellyseerr).",
  testable: true,
  fields: [
    {
      key: "url",
      label: "Address",
      type: "url",
      default: "",
      placeholder: "http://seerr:5055",
    },
    {
      key: "apiKey",
      label: "API key",
      type: "secret",
      help: "Seerr → Settings → General → API Key. Only needed for request emails. Kondo uses it to read requests and to run Seerr's Plex scan as soon as Plex adds something.",
    },
  ],
};

// Seerr's status numbers (server/constants/media.ts).
export const REQUEST_APPROVED = 2;
export const REQUEST_COMPLETED = 5;
export const MEDIA_PARTIALLY_AVAILABLE = 4;
export const MEDIA_AVAILABLE = 5;

export interface SeerrSeasonStatus {
  seasonNumber: number;
  status: number;
}

/** The parts of a Seerr request that Kondo reads. */
export interface SeerrRequest {
  id: number;
  status: number;
  type: "movie" | "tv";
  is4k: boolean;
  createdAt: string;
  media: { tmdbId: number; status: number };
  seasons?: { seasonNumber: number }[];
  requestedBy: { id: number; email?: string; displayName?: string };
}

export interface SeerrTitle {
  title: string;
  year: string | null;
  posterPath: string | null;
  /** TMDB's episode count per season (shows only). */
  episodeCounts: Map<number, number>;
  media: {
    status: number;
    seasons: SeerrSeasonStatus[];
    ratingKey: string | null;
    /** Plex Web link to the film or show. */
    plexUrl: string | null;
  } | null;
}

interface RawTitle {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;
  seasons?: { seasonNumber: number; episodeCount?: number }[];
  mediaInfo?: {
    status: number;
    seasons?: SeerrSeasonStatus[];
    ratingKey?: string | null;
    mediaUrl?: string | null;
  };
}

interface Page<T> {
  pageInfo: { results: number };
  results: T[];
}

export class SeerrClient {
  constructor(private readonly settings: SettingsStore) {}

  /** The address is enough for "is it up" checks. */
  url(): string {
    return String(this.settings.values("seerr").url ?? "");
  }

  configured(): boolean {
    return this.settings.hasValues("seerr", ["url", "apiKey"]);
  }

  private get<T>(path: string, timeoutMs = 15_000): Promise<T> {
    return requestJson<T>(`${this.url()}/api/v1${path}`, {
      headers: { "X-Api-Key": this.settings.secret("seerr", "apiKey") ?? "" },
      timeoutMs,
    });
  }

  /** Every request, newest first. */
  async requests(): Promise<SeerrRequest[]> {
    const all: SeerrRequest[] = [];
    const take = 100;
    for (let skip = 0; ; skip += take) {
      const page = await this.get<Page<SeerrRequest>>(
        `/request?take=${take}&skip=${skip}&filter=all`,
      );
      all.push(...page.results);
      if (page.results.length < take || all.length >= page.pageInfo.results) return all;
    }
  }

  /** A user's email address (the request list may leave it out). */
  async userEmail(userId: number): Promise<string | null> {
    const user = await this.get<{ email?: string }>(`/user/${userId}`);
    return user.email || null;
  }

  async title(type: "movie" | "tv", tmdbId: number): Promise<SeerrTitle> {
    const raw = await this.get<RawTitle>(`/${type}/${tmdbId}`);
    const date = raw.releaseDate || raw.firstAirDate || "";
    return {
      title: raw.title ?? raw.name ?? `TMDB ${tmdbId}`,
      year: date ? date.slice(0, 4) : null,
      posterPath: raw.posterPath ?? null,
      episodeCounts: new Map(
        (raw.seasons ?? []).map((s) => [s.seasonNumber, Number(s.episodeCount ?? 0)]),
      ),
      media: raw.mediaInfo
        ? {
            status: raw.mediaInfo.status,
            seasons: raw.mediaInfo.seasons ?? [],
            ratingKey: raw.mediaInfo.ratingKey ?? null,
            plexUrl: raw.mediaInfo.mediaUrl ?? null,
          }
        : null,
    };
  }

  /**
   * Runs Seerr's "Plex Recently Added Scan" now (it normally runs every 5 minutes), so Seerr
   * marks what Plex just added as available, and waits for it to finish (about 4 s).
   */
  async syncRecentlyAdded(timeoutMs = 120_000): Promise<void> {
    const job = "plex-recently-added-scan";
    await requestJson(`${this.url()}/api/v1/settings/jobs/${job}/run`, {
      method: "POST",
      headers: { "X-Api-Key": this.settings.secret("seerr", "apiKey") ?? "" },
      timeoutMs: 15_000,
    });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const jobs = await this.get<{ id: string; running?: boolean }[]>("/settings/jobs");
      if (!jobs.find((j) => j.id === job)?.running) return;
      if (Date.now() > deadline) throw new Error("Seerr's Plex scan is taking over 2 minutes");
    }
  }

  /** Seerr's public address and name, for links in emails. */
  async main(): Promise<{ applicationUrl: string; applicationTitle: string }> {
    const main = await this.get<{ applicationUrl?: string; applicationTitle?: string }>(
      "/settings/main",
    );
    return {
      applicationUrl: (main.applicationUrl ?? "").replace(/\/+$/, ""),
      applicationTitle: main.applicationTitle || "Seerr",
    };
  }

  async test(): Promise<TestResult> {
    if (!this.url()) return { ok: false, message: "Fill in the address first." };
    try {
      const status = await this.get<{ version?: string }>("/status", 5000);
      if (!this.settings.secret("seerr", "apiKey")) {
        return {
          ok: true,
          message: `Seerr ${status.version ?? ""} is answering. Add the API key for request emails.`,
        };
      }
      const main = await this.main();
      const requests = await this.get<Page<unknown>>("/request?take=1");
      return {
        ok: true,
        message: `Connected to ${main.applicationTitle} ${status.version ?? ""} — ${requests.pageInfo.results} requests.`,
      };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }
}
