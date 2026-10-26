import type { FastifyBaseLogger } from "fastify";
import type { HealthCheck, HealthStatus, HealthSummary } from "../../shared/api.js";
import type { EventBus } from "./events.js";

export interface CheckResult {
  status: HealthStatus;
  message: string;
}

export interface HealthCheckDef {
  id: string;
  label: string;
  check: () => CheckResult | Promise<CheckResult>;
}

const RANK: Record<HealthStatus, number> = { ok: 0, warn: 1, error: 2 };

export function worst(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");
}

/** Runs every registered check on a timer and keeps the latest results. */
export class Health {
  private readonly checks: HealthCheckDef[] = [];
  private latest: HealthSummary = { overall: "ok", checks: [] };
  private readonly listeners: ((summary: HealthSummary) => void | Promise<void>)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
  ) {}

  register(def: HealthCheckDef): void {
    if (this.checks.some((c) => c.id === def.id))
      throw new Error(`Health check ${def.id} registered twice`);
    this.checks.push(def);
  }

  onEvaluated(listener: (summary: HealthSummary) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  summary(): HealthSummary {
    return this.latest;
  }

  async evaluate(): Promise<HealthSummary> {
    const checkedAt = new Date().toISOString();
    const checks: HealthCheck[] = await Promise.all(
      this.checks.map(async (def) => {
        try {
          const result = await Promise.race([
            Promise.resolve(def.check()),
            new Promise<CheckResult>((resolve) =>
              setTimeout(
                () => resolve({ status: "error", message: "The check timed out" }),
                15_000,
              ).unref(),
            ),
          ]);
          return { id: def.id, label: def.label, ...result, checkedAt };
        } catch (error) {
          return {
            id: def.id,
            label: def.label,
            status: "error" as const,
            message: `The check itself failed: ${(error as Error).message}`,
            checkedAt,
          };
        }
      }),
    );
    const summary: HealthSummary = { overall: worst(checks.map((c) => c.status)), checks };
    const changed =
      JSON.stringify(summary.checks.map((c) => [c.id, c.status, c.message])) !==
      JSON.stringify(this.latest.checks.map((c) => [c.id, c.status, c.message]));
    this.latest = summary;
    if (changed) this.events.emit({ type: "status.changed", reason: "health" });
    for (const listener of this.listeners) {
      try {
        await listener(summary);
      } catch (error) {
        this.log.error({ err: error }, "health listener failed");
      }
    }
    return summary;
  }

  start(intervalMs = 60_000): void {
    void this.evaluate();
    this.timer = setInterval(() => void this.evaluate(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
