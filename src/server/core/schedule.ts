import type { KondoEvent, ScheduleInfo, SlotId } from "../../shared/api.js";
import type { SettingsSection } from "../../shared/settings.js";
import type { PlexMonitor } from "../integrations/plex.js";
import type { EventBus } from "./events.js";
import type { SettingsStore } from "./settings.js";

const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const scheduleSettings: SettingsSection = {
  scope: "schedule",
  title: "Schedule",
  group: "core",
  description:
    "Heavy work runs in the night window. Idle mode also lets it run at other times, but only while nobody is watching.",
  fields: [
    {
      key: "paused",
      label: "Pause all work",
      type: "boolean",
      default: false,
      help: "Nothing new starts, and anything running freezes where it is until you resume. Also on the dashboard.",
    },
    {
      key: "timeZone",
      label: "Time zone",
      type: "timezone",
      default: systemTimeZone,
      help: "The window follows this zone, including summer time. E.g. Europe/Dublin.",
    },
    { key: "windowStart", label: "Night window starts", type: "time", default: "02:00" },
    { key: "windowEnd", label: "Night window ends", type: "time", default: "08:00" },
    {
      key: "idleMode",
      label: "Also work when Plex is idle",
      type: "boolean",
      default: false,
      help: "Outside the window, work only starts after Plex has been completely idle for a while, and freezes the moment anyone presses play.",
    },
    {
      key: "idleQuietMinutes",
      label: "Idle for at least (minutes)",
      type: "number",
      default: 15,
      min: 5,
      max: 240,
    },
  ],
};

export const encodingSettings: SettingsSection = {
  scope: "encoding",
  title: "Encoders",
  group: "core",
  fields: [
    { key: "gpuEnabled", label: "Use the GPU slot", type: "boolean", default: true },
    {
      key: "gpuBacklogHours",
      label: "Use the GPU only when the CPU has more than this much work (hours)",
      type: "number",
      default: 72,
      min: 0,
      max: 720,
      help: "The CPU makes smaller files at the same quality, so the GPU only helps out with big batches, taking the files with the smallest savings. Measured in hours of CPU encoding at its recent speed. 0 = always use the GPU.",
    },
    { key: "cpuEnabled", label: "Use the CPU slot", type: "boolean", default: true },
    {
      key: "cpuCrf",
      label: "CPU quality (x265 CRF)",
      type: "number",
      default: 0,
      min: 0,
      max: 40,
      step: 0.5,
      help: "Lower is better quality and bigger. 25 matched the GPU's quality on this library with files about 28% smaller. 0 leaves the CPU slot unused.",
    },
    {
      key: "cpuPreset",
      label: "CPU speed (x265 preset)",
      type: "select",
      default: "medium",
      options: [
        { value: "fast", label: "Fast" },
        { value: "medium", label: "Medium" },
        { value: "slow", label: "Slow: smaller files, about half the speed" },
      ],
      help: "The CRF was matched at Medium; a different speed changes what it gives.",
    },
    {
      key: "cpuThreads",
      label: "CPU threads for encoding",
      type: "number",
      default: 16,
      min: 1,
      max: 256,
      help: "In total, shared evenly between the CPU encodes. Leave headroom for Plex and everything else on the host.",
    },
    {
      key: "cpuEncodes",
      label: "CPU encodes at once",
      type: "number",
      default: 2,
      min: 1,
      max: 4,
      help: "One x265 encode of a 1080p file keeps only about 11 threads busy, so with more threads than that, two at once get through the work faster.",
    },
    { key: "ffmpegPath", label: "ffmpeg", type: "string", default: "ffmpeg" },
    { key: "ffprobePath", label: "ffprobe", type: "string", default: "ffprobe" },
  ],
};

/** How many CPU encodes run at once (one if unset). */
export function cpuEncodes(encoding: Record<string, unknown>): number {
  const n = Math.floor(Number(encoding.cpuEncodes ?? 1));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** x265 threads for each CPU encode: the total split evenly between them. */
export function cpuThreadsPerEncode(encoding: Record<string, unknown>): number {
  return Math.max(1, Math.floor(Number(encoding.cpuThreads) / cpuEncodes(encoding)));
}

export interface SlotDecision {
  allowed: boolean;
  reason: string;
}

/** The clock time (minutes after midnight) in a time zone. */
export function clockIn(date: Date, timeZone: string): { minutes: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return {
    minutes: hour * 60 + minute,
    label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function parseClock(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Windows may cross midnight (e.g. 22:00–06:00). Equal start and end = no window. */
export function isInWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface SlotInputs {
  enabled: boolean;
  force: boolean;
  inWindow: boolean;
  window: string;
  idleMode: boolean;
  idleQuietMinutes: number;
  plex: {
    configured: boolean;
    reachable: boolean;
    sessions: number;
    gpuTranscoding: boolean;
    cpuTranscoding: boolean;
    quietForMs: number;
  };
}

/** Whether an encoder slot may work right now — the rules from DESIGN.md. */
export function decideSlot(slot: "gpu" | "cpu", input: SlotInputs): SlotDecision {
  const { plex } = input;
  if (!input.enabled) return { allowed: false, reason: "Turned off in settings" };
  if (!plex.configured) {
    return {
      allowed: false,
      reason: "Waiting for Plex to be set up, so Kondo can see who's watching",
    };
  }
  if (!plex.reachable) {
    return { allowed: false, reason: "Can't reach Plex, so assuming someone is watching" };
  }
  if (input.inWindow || input.force) {
    if (slot === "gpu" && plex.gpuTranscoding) {
      return { allowed: false, reason: "Paused while Plex transcodes on the GPU" };
    }
    if (slot === "cpu" && plex.cpuTranscoding) {
      return { allowed: false, reason: "Paused while Plex transcodes on the CPU" };
    }
    return {
      allowed: true,
      reason: input.inWindow ? `Night window (${input.window})` : "Started by hand",
    };
  }
  if (!input.idleMode)
    return { allowed: false, reason: `Outside the night window (${input.window})` };
  if (plex.sessions > 0) return { allowed: false, reason: "Paused: someone is watching" };
  const remaining = input.idleQuietMinutes * 60_000 - plex.quietForMs;
  if (remaining > 0) {
    return {
      allowed: false,
      reason: `Plex is idle; starting in ${Math.ceil(remaining / 60_000)} min if it stays quiet`,
    };
  }
  return { allowed: true, reason: "Idle mode: nobody is watching" };
}

export interface MissedWindow {
  endedAt: string;
  queued: number;
}

/**
 * Turns settings + Plex activity into slot decisions, notices the window
 * opening/closing, and remembers a night where work was waiting but none got done.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastDecisions = "";
  private window: { open: boolean; queuedAtStart: number; workDone: boolean } | null = null;
  private missed: MissedWindow | null = null;
  private queuedCount: () => number = () => 0;

  constructor(
    private readonly settings: SettingsStore,
    private readonly plex: PlexMonitor,
    private readonly events: EventBus,
  ) {}

  /** Lets the scheduler see how much encoder work is waiting (set by the job queue). */
  setQueuedCounter(counter: () => number): void {
    this.queuedCount = counter;
  }

  start(intervalMs = 15_000): void {
    this.unsubscribe = this.events.subscribe((event) => this.onEvent(event));
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }

  info(now = new Date()): ScheduleInfo {
    const s = this.settings.values("schedule");
    const timeZone = String(s.timeZone);
    const clock = clockIn(now, timeZone);
    return {
      timeZone,
      windowStart: String(s.windowStart),
      windowEnd: String(s.windowEnd),
      inWindow: isInWindow(
        clock.minutes,
        parseClock(String(s.windowStart)),
        parseClock(String(s.windowEnd)),
      ),
      idleMode: Boolean(s.idleMode),
      idleQuietMinutes: Number(s.idleQuietMinutes),
      localTime: clock.label,
      paused: Boolean(s.paused),
    };
  }

  missedWindow(): MissedWindow | null {
    return this.missed;
  }

  decide(slot: SlotId, force: boolean, now = new Date()): SlotDecision {
    // Pausing beats everything, including "Encode now".
    const info = this.info(now);
    if (info.paused) return { allowed: false, reason: "Paused by you" };
    if (slot === "general") return { allowed: true, reason: "Always available" };
    const encoding = this.settings.values("encoding");
    const activity = this.plex.activity();
    return decideSlot(slot, {
      enabled: Boolean(slot === "gpu" ? encoding.gpuEnabled : encoding.cpuEnabled),
      force,
      inWindow: info.inWindow,
      window: `${info.windowStart}–${info.windowEnd}`,
      idleMode: info.idleMode,
      idleQuietMinutes: info.idleQuietMinutes,
      plex: {
        configured: activity.configured,
        reachable: activity.reachable,
        sessions: activity.sessions.length,
        gpuTranscoding: this.plex.gpuTranscoding(),
        cpuTranscoding: this.plex.cpuTranscoding(),
        quietForMs: this.plex.quietForMs(now.getTime()),
      },
    });
  }

  tick(now = new Date()): void {
    const open = this.info(now).inWindow;
    if (open && !this.window?.open) {
      this.window = { open: true, queuedAtStart: this.queuedCount(), workDone: false };
      this.missed = null;
    } else if (!open && this.window?.open) {
      // A window spent paused on purpose isn't a missed one.
      if (this.window.queuedAtStart > 0 && !this.window.workDone && !this.info(now).paused) {
        this.missed = { endedAt: now.toISOString(), queued: this.queuedCount() };
      }
      this.window = { open: false, queuedAtStart: 0, workDone: false };
    } else if (!this.window) {
      this.window = { open, queuedAtStart: open ? this.queuedCount() : 0, workDone: false };
    }

    const decisions = JSON.stringify([
      this.decide("gpu", false, now),
      this.decide("cpu", false, now),
      this.decide("general", false, now),
    ]);
    if (decisions !== this.lastDecisions) {
      this.lastDecisions = decisions;
      this.events.emit({ type: "status.changed", reason: "schedule" });
    }
  }

  private onEvent(event: KondoEvent): void {
    if (
      event.type === "settings.changed" &&
      (event.scope === "schedule" || event.scope === "encoding")
    ) {
      this.tick();
    }
    if (event.type === "job.updated" && event.job.slot !== "general") {
      const working = event.job.state === "running" || event.job.state === "succeeded";
      if (working) {
        if (this.window?.open) this.window.workDone = true;
        this.missed = null;
      }
    }
  }
}
