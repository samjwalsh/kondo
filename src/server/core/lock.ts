import { JobCancelledError } from "./jobs.js";

/** One holder at a time, first come first served. Waiting can be cancelled. */
export class Lock {
  private held = false;
  private waiters: (() => void)[] = [];

  get busy(): boolean {
    return this.held;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.held = false;
      this.waiters.shift()?.();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    while (this.held) {
      if (signal?.aborted) throw new JobCancelledError();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== wake);
          reject(new JobCancelledError());
        };
        this.waiters.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal?.aborted) throw new JobCancelledError();
    this.held = true;
  }
}
