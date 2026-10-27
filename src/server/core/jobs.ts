import type { ChildProcess } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";
import type {
  Job,
  JobDetail,
  JobLogLine,
  JobState,
  KondoEvent,
  SlotId,
  SlotStatus,
} from "../../shared/api.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import { type RunOptions, type RunResult, runProcess } from "./process.js";
import type { SlotDecision } from "./schedule.js";

export class JobCancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

export interface JobContext<P> {
  readonly id: number;
  readonly payload: P;
  readonly signal: AbortSignal;
  /** Fraction 0–1 (or null if unknown) plus a short human-readable status. */
  progress(fraction: number | null, text?: string): void;
  log(message: string, level?: JobLogLine["level"]): void;
  /** Waits while the job is paused; throws JobCancelledError once it's cancelled. */
  checkpoint(): Promise<void>;
  /** Runs a child process that is frozen, resumed and stopped together with the job. */
  run(command: string, args: string[], options?: Omit<RunOptions, "register">): Promise<RunResult>;
}

export interface JobType<P, R> {
  slot: SlotId | ((payload: P) => SlotId);
  title: (payload: P) => string;
  run: (ctx: JobContext<P>) => Promise<R>;
  /** Called at start-up for a job that was mid-run when Kondo stopped, to clean up partial work. */
  recover?: (job: Job, payload: P) => void | Promise<void>;
}

export interface EnqueueOptions {
  priority?: number;
  force?: boolean;
  /** At most one queued/running job may hold a given key. */
  dedupeKey?: string;
}

export interface SlotConfig {
  id: SlotId;
  label: string;
  concurrency: number;
}

export type SlotPolicy = (slot: SlotId, force: boolean) => SlotDecision;

const MAX_ATTEMPTS = 3;
const PROGRESS_WRITE_MS = 1000;
const KEEP_FINISHED_DAYS = 30;
const MAX_LOG_LINES = 500;

type Row = Record<string, unknown>;

function toJob(row: Row): Job {
  return {
    id: Number(row.id),
    tool: String(row.tool),
    type: String(row.type),
    slot: String(row.slot) as SlotId,
    title: String(row.title),
    state: String(row.state) as JobState,
    priority: Number(row.priority),
    force: Boolean(row.force),
    progress: row.progress === null ? null : Number(row.progress),
    progressText: row.progress_text === null ? null : String(row.progress_text),
    result: row.result === null ? null : JSON.parse(String(row.result)),
    error: row.error === null ? null : String(row.error),
    attempts: Number(row.attempts),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    updatedAt: String(row.updated_at),
  };
}

/** A job that is currently running (or frozen) in this process. */
class ActiveJob {
  readonly controller = new AbortController();
  readonly processes = new Set<ChildProcess>();
  paused = false;
  stopReason: "cancel" | "shutdown" | null = null;
  pendingProgress: { fraction: number | null; text: string | null } | null = null;
  progressTimer: NodeJS.Timeout | null = null;
  private waiters: (() => void)[] = [];

  constructor(
    readonly id: number,
    readonly slot: SlotId,
    readonly force: boolean,
  ) {}

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const p of this.processes) p.kill("SIGSTOP");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const p of this.processes) p.kill("SIGCONT");
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  stop(reason: "cancel" | "shutdown"): void {
    this.stopReason = reason;
    // Jobs can read signal.reason: "cancel" (by a person) or "shutdown" (Kondo restarting).
    this.controller.abort(reason);
    // A frozen process can't act on SIGTERM until it's continued.
    this.resume();
    for (const p of this.processes) {
      p.kill("SIGTERM");
      setTimeout(() => p.exitCode === null && p.kill("SIGKILL"), 10_000).unref();
    }
  }

  async checkpoint(): Promise<void> {
    while (this.paused && !this.controller.signal.aborted) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.controller.signal.aborted) throw new JobCancelledError();
  }
}

export class JobQueue {
  // biome-ignore lint/suspicious/noExplicitAny: handlers have their own payload/result types
  private readonly types = new Map<string, JobType<any, any>>();
  private readonly active = new Map<number, ActiveJob>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private tickQueued = false;
  private stopped = true;
  private policy: SlotPolicy = () => ({ allowed: true, reason: "" });

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly slots: SlotConfig[],
  ) {}

  setPolicy(policy: SlotPolicy): void {
    this.policy = policy;
  }

  define<P, R>(tool: string, type: string, def: JobType<P, R>): void {
    const key = `${tool}:${type}`;
    if (this.types.has(key)) throw new Error(`Job type ${key} defined twice`);
    this.types.set(key, def);
  }

  enqueue<P>(tool: string, type: string, payload: P, options: EnqueueOptions = {}): Job {
    const def = this.types.get(`${tool}:${type}`);
    if (!def) throw new Error(`Unknown job type ${tool}:${type}`);
    if (options.dedupeKey) {
      const existing = this.db
        .prepare(
          "SELECT * FROM jobs WHERE dedupe_key = ? AND state IN ('queued', 'running', 'paused')",
        )
        .get(options.dedupeKey);
      if (existing) return toJob(existing);
    }
    const slot = typeof def.slot === "function" ? def.slot(payload) : def.slot;
    const now = new Date().toISOString();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO jobs (tool, type, slot, title, state, priority, force, payload, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tool,
        type,
        slot,
        def.title(payload),
        options.priority ?? 0,
        options.force ? 1 : 0,
        JSON.stringify(payload),
        options.dedupeKey ?? null,
        now,
        now,
      );
    const job = this.emitJob(Number(lastInsertRowid));
    this.queueTick();
    return job;
  }

  get(id: number): JobDetail | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) return null;
    const logs = this.db
      .prepare("SELECT ts, level, message FROM job_logs WHERE job_id = ? ORDER BY id")
      .all(id)
      .map((l) => ({
        ts: String(l.ts),
        level: String(l.level) as JobLogLine["level"],
        message: String(l.message),
      }));
    return { ...toJob(row), logs };
  }

  list(options: { limit?: number; tool?: string } = {}): Job[] {
    const limit = Math.min(options.limit ?? 100, 500);
    const rows = options.tool
      ? this.db
          .prepare("SELECT * FROM jobs WHERE tool = ? ORDER BY id DESC LIMIT ?")
          .all(options.tool, limit)
      : this.db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map(toJob);
  }

  /** Jobs of one tool/type that are queued, running or paused. */
  activeCount(tool: string, type: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE tool = ? AND type = ? AND state IN ('queued', 'running', 'paused')",
      )
      .get(tool, type);
    return Number(row?.n ?? 0);
  }

  queuedCount(slots: SlotId[]): number {
    const placeholders = slots.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued' AND slot IN (${placeholders})`,
      )
      .get(...slots);
    return Number(row?.n ?? 0);
  }

  /** Running (not frozen) jobs with no progress for a while. */
  stuck(olderThanMs: number): Job[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.db
      .prepare("SELECT * FROM jobs WHERE state = 'running' AND updated_at < ?")
      .all(cutoff)
      .map(toJob);
  }

  cancel(id: number): Job | null {
    const job = this.get(id);
    if (!job) return null;
    const active = this.active.get(id);
    if (active) {
      active.stop("cancel");
      return job;
    }
    if (job.state === "queued") {
      this.finish(id, "cancelled", {});
      this.addLog(id, "Cancelled before it started");
    }
    return this.get(id);
  }

  /** Queues a fresh copy of a failed or cancelled job. */
  retry(id: number): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) return null;
    const job = toJob(row);
    if (job.state !== "failed" && job.state !== "cancelled") return job;
    return this.enqueue(job.tool, job.type, JSON.parse(String(row.payload)), {
      priority: job.priority,
      force: job.force,
    });
  }

  /** Re-queues jobs that were mid-run when Kondo last stopped. Call before start(). */
  async recover(): Promise<void> {
    const cutoff = new Date(Date.now() - KEEP_FINISHED_DAYS * 86_400_000).toISOString();
    this.db
      .prepare(
        "DELETE FROM jobs WHERE state IN ('succeeded', 'failed', 'cancelled') AND finished_at < ?",
      )
      .run(cutoff);

    const interrupted = this.db
      .prepare("SELECT * FROM jobs WHERE state IN ('running', 'paused')")
      .all();
    for (const row of interrupted) {
      const job = toJob(row);
      const def = this.types.get(`${job.tool}:${job.type}`);
      try {
        await def?.recover?.(job, JSON.parse(String(row.payload)));
      } catch (error) {
        this.addLog(job.id, `Clean-up after restart failed: ${(error as Error).message}`, "error");
      }
      if (job.attempts >= MAX_ATTEMPTS) {
        this.finish(job.id, "failed", { error: `Interrupted ${job.attempts} times; giving up` });
      } else {
        this.db
          .prepare(
            "UPDATE jobs SET state = 'queued', progress = NULL, progress_text = NULL, updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), job.id);
        this.addLog(job.id, "Interrupted (Kondo restarted); queued again", "warn");
        this.emitJob(job.id);
      }
    }
  }

  start(tickMs = 2000): void {
    this.stopped = false;
    this.unsubscribe = this.events.subscribe((event: KondoEvent) => {
      if (event.type === "status.changed" || event.type === "settings.changed") this.queueTick();
    });
    this.timer = setInterval(() => this.tick(), tickMs);
    this.tick();
  }

  /** Stops running jobs without marking them finished; recover() re-queues them next time. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    for (const active of this.active.values()) active.stop("shutdown");
    const deadline = Date.now() + 5000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  slotStatuses(): SlotStatus[] {
    return this.slots.map((slot) => {
      const decision = this.policy(slot.id, false);
      const jobs = [...this.active.values()]
        .filter((a) => a.slot === slot.id)
        .map((a) => this.get(a.id))
        .filter((j): j is JobDetail => j !== null)
        .map(({ logs: _logs, ...job }) => job);
      return {
        ...slot,
        allowed: decision.allowed,
        reason: decision.reason,
        jobs,
        queued: this.queuedCount([slot.id]),
      };
    });
  }

  private queueTick(): void {
    if (this.tickQueued || this.stopped) return;
    this.tickQueued = true;
    setImmediate(() => {
      this.tickQueued = false;
      this.tick();
    });
  }

  tick(): void {
    if (this.stopped) return;
    // Freeze or wake running jobs as the rules change.
    for (const active of this.active.values()) {
      if (active.stopReason) continue;
      const decision = this.policy(active.slot, active.force);
      if (!decision.allowed && !active.paused) {
        active.pause();
        // Save the last progress now so the frozen job shows where it really stopped.
        this.flushProgress(active);
        this.setState(active.id, "paused");
        this.addLog(active.id, `Paused: ${decision.reason}`);
      } else if (decision.allowed && active.paused) {
        active.resume();
        this.setState(active.id, "running");
        this.addLog(active.id, "Resumed");
      }
    }
    // Fill free slots. Frozen jobs keep their slot.
    for (const slot of this.slots) {
      let busy = [...this.active.values()].filter((a) => a.slot === slot.id).length;
      if (busy >= slot.concurrency) continue;
      const candidates = this.db
        .prepare(
          "SELECT * FROM jobs WHERE state = 'queued' AND slot = ? ORDER BY priority DESC, id ASC LIMIT 50",
        )
        .all(slot.id);
      for (const row of candidates) {
        if (busy >= slot.concurrency) break;
        if (!this.policy(slot.id, Boolean(row.force)).allowed) continue;
        this.startJob(row);
        busy++;
      }
    }
  }

  private startJob(row: Row): void {
    const job = toJob(row);
    const def = this.types.get(`${job.tool}:${job.type}`);
    if (!def) {
      this.finish(job.id, "failed", { error: `Nothing handles ${job.tool}:${job.type} any more` });
      return;
    }
    const active = new ActiveJob(job.id, job.slot, job.force);
    this.active.set(job.id, active);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET state = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?),
         error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, job.id);
    this.addLog(
      job.id,
      job.attempts > 0 ? `Started again (attempt ${job.attempts + 1})` : "Started",
    );
    this.emitJob(job.id);

    const payload = JSON.parse(String(row.payload));
    def
      .run(this.context(active, payload))
      .then((result) => {
        this.flushProgress(active);
        if (!this.stopped) this.finish(job.id, "succeeded", { result: result ?? null });
      })
      .catch((error: Error) => {
        this.flushProgress(active);
        if (active.stopReason === "shutdown" || this.stopped) return; // recover() picks it up
        if (active.stopReason === "cancel") {
          this.addLog(job.id, "Cancelled");
          this.finish(job.id, "cancelled", {});
        } else {
          this.addLog(job.id, error.message, "error");
          this.finish(job.id, "failed", { error: error.message });
        }
      })
      .finally(() => {
        this.active.delete(job.id);
        this.queueTick();
      });
  }

  private context<P>(active: ActiveJob, payload: P): JobContext<P> {
    return {
      id: active.id,
      payload,
      signal: active.controller.signal,
      progress: (fraction, text) => {
        active.pendingProgress = {
          fraction: fraction === null ? null : Math.max(0, Math.min(1, fraction)),
          text: text ?? null,
        };
        if (!active.progressTimer) {
          active.progressTimer = setTimeout(() => this.flushProgress(active), PROGRESS_WRITE_MS);
        }
      },
      log: (message, level = "info") => this.addLog(active.id, message, level),
      checkpoint: () => active.checkpoint(),
      run: (command, args, options = {}) => {
        if (active.controller.signal.aborted) return Promise.reject(new JobCancelledError());
        return runProcess(command, args, {
          ...options,
          register: (child) => {
            active.processes.add(child);
            if (active.paused) child.kill("SIGSTOP");
            return () => active.processes.delete(child);
          },
        }).then((result) => {
          if (active.controller.signal.aborted) throw new JobCancelledError();
          return result;
        });
      },
    };
  }

  private flushProgress(active: ActiveJob): void {
    if (active.progressTimer) clearTimeout(active.progressTimer);
    active.progressTimer = null;
    const pending = active.pendingProgress;
    active.pendingProgress = null;
    if (!pending || this.stopped) return;
    this.db
      .prepare("UPDATE jobs SET progress = ?, progress_text = ?, updated_at = ? WHERE id = ?")
      .run(pending.fraction, pending.text, new Date().toISOString(), active.id);
    this.emitJob(active.id);
  }

  private setState(id: number, state: JobState): void {
    this.db
      .prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), id);
    this.emitJob(id);
  }

  private finish(
    id: number,
    state: "succeeded" | "failed" | "cancelled",
    outcome: { result?: unknown; error?: string },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET state = ?, result = ?, error = ?, finished_at = ?, updated_at = ?,
         progress = CASE WHEN ? = 'succeeded' THEN 1 ELSE progress END WHERE id = ?`,
      )
      .run(
        state,
        outcome.result === undefined ? null : JSON.stringify(outcome.result),
        outcome.error ?? null,
        now,
        now,
        state,
        id,
      );
    if (state === "succeeded") this.addLog(id, "Finished");
    this.emitJob(id);
  }

  private addLog(id: number, message: string, level: JobLogLine["level"] = "info"): void {
    if (this.stopped && level === "info") return;
    const line: JobLogLine = { ts: new Date().toISOString(), level, message };
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)")
      .run(id, line.ts, level, message);
    if (Number(lastInsertRowid) % 50 === 0) {
      this.db
        .prepare(
          `DELETE FROM job_logs WHERE job_id = ? AND id <= (
             SELECT id FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        )
        .run(id, id, MAX_LOG_LINES);
    }
    this.events.emit({ type: "job.log", jobId: id, line });
    if (level !== "info") this.log[level === "warn" ? "warn" : "error"]({ jobId: id }, message);
  }

  private emitJob(id: number): Job {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) throw new Error(`Job ${id} vanished`);
    const job = toJob(row);
    this.events.emit({ type: "job.updated", job });
    return job;
  }
}
