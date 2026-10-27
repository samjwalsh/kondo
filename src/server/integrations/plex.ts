import type { FastifyBaseLogger } from "fastify";
import type { PlexActivity, PlexSession } from "../../shared/api.js";
import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { EventBus } from "../core/events.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, request, requestJson } from "./http.js";

export const plexSettings: SettingsSection = {
  scope: "plex",
  title: "Plex",
  group: "integration",
  description: "Kondo watches Plex so it never gets in the way of someone streaming.",
  testable: true,
  fields: [
    {
      key: "url",
      label: "Server address",
      type: "url",
      default: "http://127.0.0.1:32400",
      help: "Kondo runs on the same machine as Plex, so the default usually works.",
    },
    {
      key: "token",
      label: "Plex token",
      type: "secret",
      help: "In Plex Web open any movie or episode → ⋯ → Get Info → View XML. The token is the X-Plex-Token=… part of the address that opens.",
    },
  ],
};

// The bits of Plex's /status/sessions JSON that Kondo reads.
interface RawSession {
  type?: string;
  title?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  User?: { title?: string };
  Player?: { title?: string; product?: string; state?: string };
  Media?: { Part?: { file?: string }[] }[];
  TranscodeSession?: {
    videoDecision?: string;
    transcodeHwRequested?: boolean;
    transcodeHwFullPipeline?: boolean;
    transcodeHwDecoding?: string;
    transcodeHwEncoding?: string;
  };
}

interface SectionsResponse {
  MediaContainer?: { Directory?: { key: string; title?: string; Location?: { path: string }[] }[] };
}

interface SessionsResponse {
  MediaContainer?: { size?: number; Metadata?: RawSession[] };
}

export function parseSessions(json: SessionsResponse): PlexSession[] {
  return (json.MediaContainer?.Metadata ?? []).map((raw) => {
    const ts = raw.TranscodeSession;
    let transcode: PlexSession["transcode"] = "none";
    if (ts?.videoDecision === "transcode") {
      const onGpu = Boolean(
        ts.transcodeHwEncoding || ts.transcodeHwDecoding || ts.transcodeHwFullPipeline,
      );
      transcode = onGpu ? "gpu" : "cpu";
    }
    const episode =
      raw.type === "episode" && raw.parentIndex !== undefined && raw.index !== undefined
        ? ` S${String(raw.parentIndex).padStart(2, "0")}E${String(raw.index).padStart(2, "0")}`
        : "";
    const title = raw.grandparentTitle
      ? `${raw.grandparentTitle}${episode} — ${raw.title ?? ""}`
      : (raw.title ?? "Unknown");
    return {
      title,
      user: raw.User?.title ?? null,
      player: raw.Player?.title ?? raw.Player?.product ?? null,
      state: raw.Player?.state ?? "playing",
      transcode,
      file: raw.Media?.[0]?.Part?.[0]?.file ?? null,
    };
  });
}

export class PlexClient {
  constructor(private readonly settings: SettingsStore) {}

  configured(): boolean {
    return this.settings.hasValues("plex", ["url", "token"]);
  }

  private base(): string {
    return String(this.settings.values("plex").url);
  }

  private headers(): Record<string, string> {
    return { "X-Plex-Token": this.settings.secret("plex", "token") ?? "" };
  }

  async sessions(): Promise<PlexSession[]> {
    const json = await requestJson<SessionsResponse>(`${this.base()}/status/sessions`, {
      headers: this.headers(),
      timeoutMs: 5000,
    });
    return parseSessions(json);
  }

  /**
   * Asks Plex to rescan one folder. Returns the library's name, or null if no Plex library
   * contains the folder.
   */
  async refreshFolder(folder: string): Promise<string | null> {
    const json = await requestJson<SectionsResponse>(`${this.base()}/library/sections`, {
      headers: this.headers(),
      timeoutMs: 5000,
    });
    const section = (json.MediaContainer?.Directory ?? []).find((d) =>
      (d.Location ?? []).some((l) => {
        const root = l.path.replace(/\/+$/, "");
        return folder === root || folder.startsWith(`${root}/`);
      }),
    );
    if (!section) return null;
    await request(
      `${this.base()}/library/sections/${section.key}/refresh?path=${encodeURIComponent(folder)}`,
      { headers: this.headers(), timeoutMs: 10_000 },
    );
    return section.title ?? section.key;
  }

  async test(): Promise<TestResult> {
    if (!this.configured()) return { ok: false, message: "Fill in the address and token first." };
    try {
      const identity = await requestJson<{ MediaContainer?: { version?: string } }>(
        `${this.base()}/identity`,
        { timeoutMs: 5000 },
      );
      const sessions = await this.sessions();
      const watching =
        sessions.length === 0 ? "nobody is watching" : `${sessions.length} watching now`;
      return {
        ok: true,
        message: `Connected to Plex ${identity.MediaContainer?.version ?? ""} — ${watching}.`,
      };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  /** Plex's live notification stream (play/pause/stop), or null if not set up. */
  notificationsUrl(): string | null {
    if (!this.configured()) return null;
    const url = new URL(`${this.base()}/:/websockets/notifications`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("X-Plex-Token", this.settings.secret("plex", "token") ?? "");
    return url.toString();
  }
}

/**
 * Keeps an up-to-date view of who's watching. Polls every few seconds and also
 * listens to Plex's notification stream so a new stream is seen almost at once.
 * Anything uncertain (not set up, unreachable, just started) counts as "busy".
 */
export class PlexMonitor {
  private sessions: PlexSession[] = [];
  private reachable = false;
  private error: string | null = null;
  private checkedAt: number | null = null;
  /** Last moment someone was (or might have been) watching. */
  private lastActiveAt = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private socket: WebSocket | null = null;
  private socketUrl: string | null = null;
  private reconnectDelay = 5000;
  private refreshQueued: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly client: PlexClient,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly pollMs = 10_000,
  ) {}

  start(): void {
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.refreshQueued) clearTimeout(this.refreshQueued);
    this.closeSocket();
  }

  activity(): PlexActivity {
    const watching = this.sessions.length > 0 || !this.reachable;
    return {
      configured: this.client.configured(),
      reachable: this.reachable,
      error: this.error,
      sessions: this.sessions,
      quietSince: watching ? null : new Date(this.lastActiveAt).toISOString(),
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
    };
  }

  /** How long Plex has been confirmed idle, in ms (0 while busy or unknown). */
  quietForMs(now = Date.now()): number {
    if (!this.reachable || this.sessions.length > 0) return 0;
    return Math.max(0, now - this.lastActiveAt);
  }

  gpuTranscoding(): boolean {
    return this.sessions.some((s) => s.transcode === "gpu");
  }

  cpuTranscoding(): boolean {
    return this.sessions.some((s) => s.transcode === "cpu");
  }

  /**
   * True if anyone is playing (or paused on) `file`, or if Plex can't be asked. Plex may see the
   * library under a different path, so a matching file name counts too.
   */
  isPlaying(file: string): boolean {
    if (!this.reachable) return true;
    const name = file.split("/").pop();
    return this.sessions.some(
      (s) => s.file === file || (s.file && s.file.split(/[\\/]/).pop() === name),
    );
  }

  async refresh(): Promise<void> {
    const before = JSON.stringify([this.reachable, this.error, this.sessions]);
    if (!this.client.configured()) {
      this.reachable = false;
      this.error = "Plex isn't set up";
      this.sessions = [];
      this.lastActiveAt = Date.now();
    } else {
      try {
        this.sessions = await this.client.sessions();
        this.reachable = true;
        this.error = null;
        if (this.sessions.length > 0) this.lastActiveAt = Date.now();
      } catch (error) {
        this.reachable = false;
        this.error = errorMessage(error);
        this.sessions = [];
        this.lastActiveAt = Date.now();
      }
    }
    this.checkedAt = Date.now();
    this.syncSocket();
    if (JSON.stringify([this.reachable, this.error, this.sessions]) !== before) {
      this.events.emit({ type: "status.changed", reason: "plex" });
    }
  }

  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = setTimeout(() => {
      this.refreshQueued = null;
      void this.refresh();
    }, 300);
  }

  private syncSocket(): void {
    const url = this.client.notificationsUrl();
    if (url === this.socketUrl) return;
    this.closeSocket();
    this.socketUrl = url;
    if (url) this.openSocket(url);
  }

  private openSocket(url: string): void {
    if (this.stopped) return;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectDelay = 5000;
    });
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          NotificationContainer?: { type?: string };
        };
        if (data.NotificationContainer?.type === "playing") this.queueRefresh();
      } catch {
        // Not JSON we understand; polling still covers it.
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
      setTimeout(() => {
        if (this.socketUrl === url && !this.socket) this.openSocket(url);
      }, delay).unref();
    });
    socket.addEventListener("error", () => {
      this.log.debug("plex notification stream error; polling continues");
    });
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
