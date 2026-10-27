// The short morning message on Telegram, sent when the night window ends. Each tool adds a few
// lines about what it did since the last one.

import type { FastifyBaseLogger } from "fastify";
import { errorMessage } from "../integrations/http.js";
import type { Telegram } from "../integrations/telegram.js";
import type { Db } from "./db.js";
import type { Scheduler } from "./schedule.js";
import type { SettingsStore } from "./settings.js";

/** Lines about what happened since `since` (an ISO time); none if there's nothing to say. */
export type SummarySection = (since: string) => string[] | Promise<string[]>;

const localDate = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

const localClock = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);

const minutesOfDay = (clock: string) => {
  const [h = 0, m = 0] = clock.split(":").map(Number);
  return h * 60 + m;
};

export class MorningSummary {
  private readonly sections: { tool: string; lines: SummarySection }[] = [];

  constructor(
    private readonly deps: {
      db: Db;
      settings: SettingsStore;
      scheduler: Scheduler;
      telegram: Telegram;
      log: FastifyBaseLogger;
    },
  ) {}

  add(tool: string, lines: SummarySection): void {
    this.sections.push({ tool, lines });
  }

  private state(key: string): string | null {
    const row = this.deps.db.prepare("SELECT value FROM core_state WHERE key = ?").get(key);
    return row ? String(row.value) : null;
  }

  private setState(key: string, value: string): void {
    this.deps.db
      .prepare("INSERT OR REPLACE INTO core_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /** Every tool's lines since `since`; a tool that fails is mentioned rather than dropped. */
  async compose(since: string): Promise<string> {
    const lines: string[] = [];
    for (const section of this.sections) {
      try {
        lines.push(...(await section.lines(since)));
      } catch (error) {
        lines.push(`(${section.tool}: couldn't summarise: ${errorMessage(error)})`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : "Kondo is running; nothing to report.";
  }

  /** Called every minute; sends once a day, just after the night window ends. */
  async tick(now = new Date()): Promise<string | null> {
    const { settings, scheduler, telegram, log } = this.deps;
    if (!settings.values("telegram").morningSummary || !telegram.configured()) return null;
    const info = scheduler.info(now);
    const today = localDate(now, info.timeZone);
    const sinceEnd = minutesOfDay(localClock(now, info.timeZone)) - minutesOfDay(info.windowEnd);
    if (sinceEnd < 0 || this.state("summaryDate") === today) return null;
    this.setState("summaryDate", today);
    // Kondo wasn't running at the time: skip today's rather than send it hours late.
    if (sinceEnd > 120) return null;
    const since = this.state("summarySince") ?? new Date(now.getTime() - 86_400_000).toISOString();
    this.setState("summarySince", now.toISOString());
    const text = await this.compose(since);
    try {
      await telegram.send(text);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "couldn't send the morning summary");
    }
    return text;
  }
}
