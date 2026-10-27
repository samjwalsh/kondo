import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, HttpError, request } from "./http.js";

export const qbittorrentSettings: SettingsSection = {
  scope: "qbittorrent",
  title: "qBittorrent",
  group: "integration",
  description: "Kondo looks inside downloads for files that don't belong there.",
  testable: true,
  fields: [
    {
      key: "url",
      label: "Web UI address",
      type: "url",
      placeholder: "http://qbittorrent:8080",
    },
    {
      key: "username",
      label: "Username",
      type: "string",
      help: "Leave both empty if qBittorrent lets this network in without logging in.",
    },
    { key: "password", label: "Password", type: "secret" },
  ],
};

export interface Torrent {
  hash: string;
  name: string;
  category: string;
  state: string;
  size: number;
  /** Where the download lives (qBittorrent's own path). */
  contentPath: string;
}

export interface TorrentFile {
  name: string;
  size: number;
  /** 0 means qBittorrent skips the file (e.g. excluded file names). */
  priority: number;
}

export class QbittorrentClient {
  private cookie: string | null = null;

  constructor(private readonly settings: SettingsStore) {}

  configured(): boolean {
    return this.settings.hasValues("qbittorrent", ["url"]);
  }

  private base(): string {
    return String(this.settings.values("qbittorrent").url).replace(/\/+$/, "");
  }

  private async login(): Promise<void> {
    const username = String(this.settings.values("qbittorrent").username ?? "");
    if (!username) return;
    const response = await request(`${this.base()}/api/v2/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username,
        password: this.settings.secret("qbittorrent", "password") ?? "",
      }),
    });
    const sid = response.headers.get("set-cookie")?.match(/SID=[^;]+/)?.[0];
    if (!sid) throw new HttpError("qBittorrent refused the username or password");
    this.cookie = sid;
  }

  /** Calls the Web API, logging in first (or again) when needed. */
  private async call(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    try {
      return await request(`${this.base()}/api/v2${path}`, {
        ...init,
        headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...init.headers },
      });
    } catch (error) {
      if (!retried && error instanceof HttpError && error.status === 403) {
        await this.login();
        return this.call(path, init, true);
      }
      throw error;
    }
  }

  async version(): Promise<string> {
    return (await this.call("/app/version")).text();
  }

  async torrents(): Promise<Torrent[]> {
    const raw = (await (await this.call("/torrents/info")).json()) as {
      hash: string;
      name: string;
      category: string;
      state: string;
      size: number;
      content_path: string;
    }[];
    return raw.map((t) => ({
      hash: t.hash,
      name: t.name,
      category: t.category,
      state: t.state,
      size: t.size,
      contentPath: t.content_path,
    }));
  }

  async files(hash: string): Promise<TorrentFile[]> {
    const response = await this.call(`/torrents/files?hash=${encodeURIComponent(hash)}`);
    return ((await response.json()) as TorrentFile[]).map((f) => ({
      name: f.name,
      size: f.size,
      priority: f.priority,
    }));
  }

  /** Removes torrents and their files from disk. */
  async deleteWithFiles(hashes: string[]): Promise<void> {
    await this.call("/torrents/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hashes: hashes.join("|"), deleteFiles: "true" }),
    });
  }

  async test(): Promise<TestResult> {
    if (!this.configured()) return { ok: false, message: "Fill in the address first." };
    try {
      const version = await this.version();
      const torrents = await this.torrents();
      return {
        ok: true,
        message: `Connected to qBittorrent ${version}: ${torrents.length} torrents.`,
      };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }
}
