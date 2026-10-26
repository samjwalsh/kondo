import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Process priority, 0 (normal) to 19 (lowest). */
  nice?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Lets the job queue pause/resume/stop the process; returns an unregister function. */
  register?: (child: ChildProcess) => () => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last lines of stderr, for error messages. */
  stderrTail: string[];
}

/** Runs a command without a shell (arguments are never interpreted). */
export function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (options.nice !== undefined && child.pid !== undefined) {
      try {
        os.setPriority(child.pid, options.nice);
      } catch {
        // Not fatal: it just runs at normal priority.
      }
    }
    const unregister = options.register?.(child);
    const stderrTail: string[] = [];
    let settled = false;

    readline
      .createInterface({ input: child.stdout })
      .on("line", (line) => options.onStdoutLine?.(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 30) stderrTail.shift();
      options.onStderrLine?.(line);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      unregister?.();
      reject(
        error.code === "ENOENT"
          ? new Error(`${command} isn't installed (or isn't on the PATH)`)
          : error,
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      unregister?.();
      resolve({ code, signal, stderrTail });
    });
  });
}
