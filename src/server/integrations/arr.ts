import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, requestJson } from "./http.js";

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

  async post<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(this.url(path), {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
