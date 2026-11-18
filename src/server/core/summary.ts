// The short morning message on Telegram, sent when the night window ends. Each tool adds a few
// lines about what it did since the last one, shown under its name as a bold heading.

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

const headingDate = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(now);

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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

  /** `tool` is the name shown as the section's heading. */
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

  /**
   * Every tool's lines since `since`, as Telegram HTML: a bold heading per tool with something to
   * say, a blank line between them. A tool that fails is mentioned rather than dropped.
   */
  async compose(since: string, title = "Kondo"): Promise<string> {
    const blocks = [`<b>${escapeHtml(title)}</b>`];
    for (const section of this.sections) {
      let lines: string[];
      try {
        lines = await section.lines(since);
      } catch (error) {
        lines = [`Couldn't summarise: ${errorMessage(error)}`];
      }
      if (lines.length === 0) continue;
      blocks.push([`<b>${escapeHtml(section.tool)}</b>`, ...lines.map(escapeHtml)].join("\n"));
    }
    if (blocks.length === 1) blocks.push("Nothing to report.");
    return blocks.join("\n\n");
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
    const text = await this.compose(since, `Kondo · ${headingDate(now, info.timeZone)}`);
    try {
      await telegram.send(text, { html: true });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "couldn't send the morning summary");
    }
    return text;
  }
}
