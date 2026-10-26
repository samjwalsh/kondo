import type { FastifyBaseLogger } from "fastify";
import type { HealthSummary } from "../../shared/api.js";
import { errorMessage } from "../integrations/http.js";
import type { Kuma } from "../integrations/kuma.js";

export interface AlertSender {
  configured(): boolean;
  send(text: string): Promise<void>;
}

/**
 * Turns health results into Telegram messages: one when a check has been failing
 * for `confirmations` evaluations in a row (so a brief blip stays quiet), a
 * reminder every `reminderMs` while it stays broken, and one when it recovers.
 */
export class Alerts {
  private readonly streaks = new Map<string, number>();
  private readonly alertedAt = new Map<string, number>();

  constructor(
    private readonly sender: AlertSender,
    private readonly log: FastifyBaseLogger,
    private readonly confirmations = 2,
    private readonly reminderMs = 12 * 3_600_000,
  ) {}

  async onHealth(summary: HealthSummary, now = Date.now()): Promise<void> {
    for (const check of summary.checks) {
      if (check.status === "error") {
        const streak = (this.streaks.get(check.id) ?? 0) + 1;
        this.streaks.set(check.id, streak);
        const last = this.alertedAt.get(check.id);
        const due =
          last === undefined ? streak >= this.confirmations : now - last >= this.reminderMs;
        if (due) {
          this.alertedAt.set(check.id, now);
          await this.send(`⚠️ Kondo — ${check.label}: ${check.message}`);
        }
      } else {
        this.streaks.delete(check.id);
        if (this.alertedAt.delete(check.id)) {
          await this.send(`✅ Kondo — ${check.label} is OK again.`);
        }
      }
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.sender.configured()) return;
    try {
      await this.sender.send(text);
    } catch (error) {
      this.log.warn({ err: errorMessage(error) }, "couldn't send Telegram alert");
    }
  }
}

/**
 * Checks in with an Uptime Kuma push monitor while Kondo is alive. It always
 * reports "up" (Kondo's own problems go to Telegram); silence is the alarm.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private last: { at: string; ok: boolean; message: string } | null = null;

  constructor(
    private readonly kuma: Kuma,
    private readonly health: () => HealthSummary,
    private readonly log: FastifyBaseLogger,
  ) {}

  lastResult(): { at: string; ok: boolean; message: string } | null {
    return this.last;
  }

  start(): void {
    const loop = async () => {
      await this.beat();
      this.timer = setTimeout(loop, this.kuma.intervalMs());
    };
    this.timer = setTimeout(loop, 5000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async beat(): Promise<void> {
    if (!this.kuma.configured()) {
      this.last = null;
      return;
    }
    const problems = this.health().checks.filter((c) => c.status === "error");
    const message =
      problems.length === 0
        ? "OK"
        : `Running, ${problems.length} problem(s): ${problems.map((p) => p.label).join(", ")}`;
    try {
      await this.kuma.push("up", message);
      this.last = { at: new Date().toISOString(), ok: true, message: "Last check-in accepted" };
    } catch (error) {
      this.last = { at: new Date().toISOString(), ok: false, message: errorMessage(error) };
      this.log.warn({ err: errorMessage(error) }, "uptime kuma heartbeat failed");
    }
  }
}
