import { afterEach, describe, expect, it } from "vitest";
import { coreMigrations, type Db, migrate, openDb } from "../src/server/core/db.js";
import { EventBus } from "../src/server/core/events.js";
import { type JobContext, JobQueue } from "../src/server/core/jobs.js";
import type { SlotId } from "../src/shared/api.js";
import { log, tempDir, waitFor } from "./helpers.js";

const queues: JobQueue[] = [];

afterEach(async () => {
  for (const q of queues.splice(0)) await q.stop();
});

function setup(dataDir = tempDir()) {
  const db = openDb(dataDir);
  migrate(db, "core", coreMigrations);
  const queue = new JobQueue(db, new EventBus(), log, [
    { id: "gpu", label: "GPU", concurrency: 1 },
    { id: "general", label: "General", concurrency: 2 },
  ]);
  const allowed = new Map<SlotId, boolean>([
    ["gpu", true],
    ["general", true],
  ]);
  queue.setPolicy((slot) => ({ allowed: allowed.get(slot) ?? false, reason: "test" }));
  queues.push(queue);
  return { db, queue, allowed, dataDir };
}

const state = (queue: JobQueue, id: number) => queue.get(id)?.state;

describe("job queue", () => {
  it("runs a job, records progress, logs and the result", async () => {
    const { queue } = setup();
    queue.define<{ n: number }, number>("t", "double", {
      slot: "general",
      title: (p) => `Double ${p.n}`,
      run: async (ctx) => {
        ctx.progress(0.5, "halfway");
        ctx.log("working");
        return ctx.payload.n * 2;
      },
    });
    queue.start(20);
    const job = queue.enqueue("t", "double", { n: 21 });
    await waitFor(() => state(queue, job.id) === "succeeded");
    const done = queue.get(job.id);
    expect(done).toMatchObject({ title: "Double 21", result: 42, progress: 1, attempts: 1 });
    expect(done?.logs.map((l) => l.message)).toEqual(["Started", "working", "Finished"]);
  });

  it("runs one job at a time in a slot with concurrency 1", async () => {
    const { queue } = setup();
    let release: () => void = () => {};
    queue.define("t", "block", {
      slot: "gpu",
      title: () => "block",
      run: () => new Promise<void>((resolve) => (release = resolve)),
    });
    queue.start(20);
    const a = queue.enqueue("t", "block", {});
    const b = queue.enqueue("t", "block", {});
    await waitFor(() => state(queue, a.id) === "running");
    expect(state(queue, b.id)).toBe("queued");
    release();
    await waitFor(() => state(queue, b.id) === "running");
    release();
    await waitFor(() => state(queue, b.id) === "succeeded");
  });

  it("waits while the slot isn't allowed, then starts", async () => {
    const { queue, allowed } = setup();
    allowed.set("gpu", false);
    queue.define("t", "noop", { slot: "gpu", title: () => "noop", run: async () => {} });
    queue.start(20);
    const job = queue.enqueue("t", "noop", {});
    await new Promise((r) => setTimeout(r, 100));
    expect(state(queue, job.id)).toBe("queued");
    allowed.set("gpu", true);
    await waitFor(() => state(queue, job.id) === "succeeded");
  });

  it("freezes a running job when the slot closes and wakes it when it reopens", async () => {
    const { queue, allowed } = setup();
    let steps = 0;
    queue.define("t", "steps", {
      slot: "gpu",
      title: () => "steps",
      run: async (ctx: JobContext<unknown>) => {
        while (steps < 50) {
          await ctx.checkpoint();
          steps++;
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    });
    queue.start(20);
    const job = queue.enqueue("t", "steps", {});
    await waitFor(() => steps > 3);
    allowed.set("gpu", false);
    await waitFor(() => state(queue, job.id) === "paused");
    const frozenAt = steps;
    await new Promise((r) => setTimeout(r, 100));
    expect(steps).toBeLessThanOrEqual(frozenAt + 1);
    allowed.set("gpu", true);
    await waitFor(() => state(queue, job.id) === "succeeded");
    expect(queue.get(job.id)?.logs.map((l) => l.message)).toContain("Resumed");
  });

  it("cancels a running child process", async () => {
    const { queue } = setup();
    queue.define("t", "sleep", {
      slot: "general",
      title: () => "sleep",
      run: async (ctx) => {
        await ctx.run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
      },
    });
    queue.start(20);
    const job = queue.enqueue("t", "sleep", {});
    await waitFor(() => state(queue, job.id) === "running");
    await new Promise((r) => setTimeout(r, 100));
    queue.cancel(job.id);
    await waitFor(() => state(queue, job.id) === "cancelled", 5000);
  });

  it("records failures and can retry them as a new job", async () => {
    const { queue } = setup();
    queue.define("t", "boom", {
      slot: "general",
      title: () => "boom",
      run: async () => {
        throw new Error("disk on fire");
      },
    });
    queue.start(20);
    const job = queue.enqueue("t", "boom", {});
    await waitFor(() => state(queue, job.id) === "failed");
    expect(queue.get(job.id)?.error).toBe("disk on fire");
    const again = queue.retry(job.id);
    expect(again?.id).not.toBe(job.id);
  });

  it("doesn't queue the same work twice", () => {
    const { queue } = setup();
    queue.define("t", "noop", { slot: "gpu", title: () => "noop", run: async () => {} });
    const a = queue.enqueue("t", "noop", {}, { dedupeKey: "file:1" });
    const b = queue.enqueue("t", "noop", {}, { dedupeKey: "file:1" });
    expect(b.id).toBe(a.id);
  });

  it("re-queues interrupted jobs after a restart, after letting the tool clean up", async () => {
    const dataDir = tempDir();
    const cleaned: number[] = [];
    const defineOn = (q: JobQueue) =>
      q.define("t", "work", {
        slot: "gpu",
        title: () => "work",
        run: async () => {},
        recover: (job) => {
          cleaned.push(job.id);
        },
      });

    const first = setup(dataDir);
    defineOn(first.queue);
    const job = first.queue.enqueue("t", "work", {});
    // Simulate a crash mid-run.
    markRunning(first.db, job.id, 1);
    const old = first.queue.enqueue("t", "work", {});
    markRunning(first.db, old.id, 3);

    const second = setup(dataDir);
    defineOn(second.queue);
    await second.queue.recover();
    expect(cleaned.sort()).toEqual([job.id, old.id].sort());
    expect(state(second.queue, job.id)).toBe("queued");
    expect(state(second.queue, old.id)).toBe("failed");
  });
});

function markRunning(db: Db, id: number, attempts: number): void {
  db.prepare("UPDATE jobs SET state = 'running', attempts = ? WHERE id = ?").run(attempts, id);
}
