import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import { EventBus } from "../src/server/core/events.js";
import { type Scheduler, scheduleSettings } from "../src/server/core/schedule.js";
import { SettingsStore } from "../src/server/core/settings.js";
import { MorningSummary } from "../src/server/core/summary.js";
import type { Telegram } from "../src/server/integrations/telegram.js";
import { telegramSettings } from "../src/server/integrations/telegram.js";
import { log, tempDir } from "./helpers.js";

function setup() {
  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  const settings = new SettingsStore(db, new EventBus());
  settings.register(scheduleSettings);
  settings.register(telegramSettings);
  settings.update("schedule", { timeZone: "Europe/Dublin", windowEnd: "08:00" });
  const sent: string[] = [];
  const telegram = {
    configured: () => true,
    send: async (text: string) => void sent.push(text),
  } as unknown as Telegram;
  const scheduler = {
    info: () => ({ timeZone: "Europe/Dublin", windowEnd: "08:00" }),
  } as unknown as Scheduler;
  const summary = new MorningSummary({ db, settings, scheduler, telegram, log });
  return { summary, sent, settings };
}

// 27 Oct 2026 is winter time in Dublin (UTC+0).
const at = (hhmm: string, day = 27) => new Date(`2026-10-${day}T${hhmm}:00Z`);

describe("morning summary", () => {
  it("puts each tool's lines under its name, and still says something on a quiet day", async () => {
    const t = setup();
    t.summary.add("Needs a look", () => ["• Unmatched in Plex: Tom & Jerry <2021>"]);
    t.summary.add("Transcode", () => ["Replaced 2 files", "1,526 to go"]);
    t.summary.add("Downloads", () => []);
    expect(await t.summary.compose("x")).toBe(
      [
        "<b>Kondo</b>",
        "",
        "<b>Needs a look</b>",
        "• Unmatched in Plex: Tom &amp; Jerry &lt;2021&gt;",
        "",
        "<b>Transcode</b>",
        "Replaced 2 files",
        "1,526 to go",
      ].join("\n"),
    );
    const quiet = setup();
    expect(await quiet.summary.compose("x")).toBe("<b>Kondo</b>\n\nNothing to report.");
  });

  it("sends once, just after the night window ends", async () => {
    const t = setup();
    t.summary.add("Transcode", () => ["hello"]);
    expect(await t.summary.tick(at("07:59"))).toBeNull();
    const first = "<b>Kondo · Tue 27 Oct</b>\n\n<b>Transcode</b>\nhello";
    expect(await t.summary.tick(at("08:01"))).toBe(first);
    expect(await t.summary.tick(at("08:02"))).toBeNull();
    expect(t.sent).toEqual([first]);
    expect(await t.summary.tick(at("08:01", 28))).toContain("Wed 28 Oct");
  });

  it("skips a day rather than send it hours late, and can be switched off", async () => {
    const t = setup();
    expect(await t.summary.tick(at("12:00"))).toBeNull();
    t.settings.update("telegram", { morningSummary: false });
    expect(await t.summary.tick(at("08:01", 28))).toBeNull();
    expect(t.sent).toEqual([]);
  });

  it("mentions a tool that failed instead of dropping the message", async () => {
    const t = setup();
    t.summary.add("Downloads", () => {
      throw new Error("qBittorrent is down");
    });
    expect(await t.summary.compose("x")).toBe(
      "<b>Kondo</b>\n\n<b>Downloads</b>\nCouldn't summarise: qBittorrent is down",
    );
  });
});
