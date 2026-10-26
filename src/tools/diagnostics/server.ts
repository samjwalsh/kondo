import type { JobContext } from "../../server/core/jobs.js";
import { runProcess } from "../../server/core/process.js";
import { defineTool, type ToolContext } from "../../server/core/tools.js";
import { errorMessage } from "../../server/integrations/http.js";
import type {
  EncoderReport,
  StartTestBody,
  TestEncodePayload,
  TestEncodeResult,
} from "./shared.js";

const REPORT_TTL_MS = 5 * 60_000;
const WANTED = ["hevc_nvenc", "libx265", "eac3"] as const;

let cached: EncoderReport | null = null;
let inFlight: Promise<EncoderReport> | null = null;

/** Probes ffmpeg once at a time; callers share the same run. */
function checkEncoders(ffmpeg: string): Promise<EncoderReport> {
  inFlight ??= probeEncoders(ffmpeg).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function lines(command: string, args: string[]): Promise<string[]> {
  const out: string[] = [];
  const result = await runProcess(command, args, { onStdoutLine: (line) => out.push(line) });
  if (result.code !== 0)
    throw new Error(result.stderrTail.at(-1) ?? `${command} exited with ${result.code}`);
  return out;
}

async function probeEncoders(ffmpeg: string): Promise<EncoderReport> {
  const report: EncoderReport = {
    ffmpeg: { found: false, version: null, error: null },
    encoders: { hevc_nvenc: false, libx265: false, eac3: false },
    gpu: null,
    checkedAt: new Date().toISOString(),
  };
  try {
    const version = await lines(ffmpeg, ["-hide_banner", "-version"]);
    report.ffmpeg = {
      found: true,
      version: version[0]?.match(/version (\S+)/)?.[1] ?? "unknown",
      error: null,
    };
    // Lines look like " V..... hevc_nvenc   NVIDIA NVENC hevc encoder (codec hevc)".
    const names = new Set(
      (await lines(ffmpeg, ["-hide_banner", "-encoders"])).map((l) => l.trim().split(/\s+/)[1]),
    );
    for (const name of WANTED) report.encoders[name] = names.has(name);
  } catch (error) {
    report.ffmpeg.error = errorMessage(error);
  }
  try {
    const [gpu] = await lines("nvidia-smi", [
      "--query-gpu=name,driver_version",
      "--format=csv,noheader",
    ]);
    const [name, driver] = (gpu ?? "").split(",").map((s) => s.trim());
    if (name && driver) report.gpu = { name, driver };
  } catch {
    // No NVIDIA driver on this machine.
  }
  cached = report;
  return report;
}

function ffmpegPath(ctx: ToolContext): string {
  return String(ctx.settings.values("encoding").ffmpegPath);
}

async function runTestEncode(
  ctx: ToolContext,
  job: JobContext<TestEncodePayload>,
): Promise<TestEncodeResult> {
  const payload = job.payload;
  const threads = Number(ctx.settings.values("encoding").cpuThreads);
  const encoder = payload.slot === "gpu" ? "hevc_nvenc" : "libx265";
  const encoderArgs =
    payload.slot === "gpu"
      ? ["-c:v", "hevc_nvenc", "-preset", "slow"]
      : [
          "-c:v",
          "libx265",
          "-preset",
          "medium",
          "-x265-params",
          `pools=${threads}:log-level=error`,
        ];
  const totalUs = payload.seconds * 1_000_000;
  const fps: number[] = [];
  let latestFps = 0;

  job.log(`Encoding ${payload.seconds} s of a 1080p test pattern with ${encoder}`);
  const result = await job.run(
    ffmpegPath(ctx),
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=1920x1080:rate=30:duration=${payload.seconds}`,
      ...encoderArgs,
      "-f",
      "null",
      "-",
    ],
    {
      nice: 19,
      onStdoutLine: (line) => {
        const [key, value] = line.split("=");
        if (key === "fps") {
          latestFps = Number(value);
          if (latestFps > 0) fps.push(latestFps);
        }
        // ffmpeg 4.x reports microseconds under both names.
        if ((key === "out_time_us" || key === "out_time_ms") && value && /^\d+$/.test(value)) {
          job.progress(Number(value) / totalUs, `${latestFps.toFixed(0)} fps`);
        }
      },
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `ffmpeg failed: ${result.stderrTail.slice(-3).join(" | ") || `exit code ${result.code}`}`,
    );
  }
  const averageFps = fps.length > 0 ? fps.reduce((a, b) => a + b, 0) / fps.length : null;
  job.log(averageFps === null ? "Done" : `Done: ${averageFps.toFixed(0)} fps on average`);
  return { encoder, seconds: payload.seconds, averageFps };
}

export default defineTool({
  id: "diagnostics",
  name: "Diagnostics",
  description:
    "Checks the encoders and runs short test encodes to prove the job queue, slots and pausing work.",

  register(ctx) {
    void checkEncoders(ffmpegPath(ctx));

    ctx.defineJob<TestEncodePayload, TestEncodeResult>("test-encode", {
      slot: (p) => p.slot,
      title: (p) => `${p.slot === "gpu" ? "GPU" : "CPU"} test encode (${p.seconds} s of video)`,
      run: (job) => runTestEncode(ctx, job),
    });

    ctx.addHealthCheck({
      id: "encoders",
      label: "Encoders",
      check: async () => {
        const report = cached ?? (await checkEncoders(ffmpegPath(ctx)));
        if (!report.ffmpeg.found) {
          return { status: "error", message: `ffmpeg: ${report.ffmpeg.error}` };
        }
        const missing = WANTED.filter((name) => !report.encoders[name]);
        return missing.length === 0
          ? { status: "ok", message: `ffmpeg ${report.ffmpeg.version} has everything Kondo needs` }
          : { status: "warn", message: `ffmpeg is missing: ${missing.join(", ")}` };
      },
    });

    ctx.setCard(() => {
      if (!cached) return { status: "ok", lines: ["Checking encoders…"] };
      if (!cached.ffmpeg.found) return { status: "error", lines: ["ffmpeg not found"] };
      const yes = (ok: boolean) => (ok ? "ready" : "missing");
      return {
        status: WANTED.every((n) => cached?.encoders[n]) ? "ok" : "warn",
        lines: [
          `GPU encoder (hevc_nvenc): ${yes(cached.encoders.hevc_nvenc)}${cached.gpu ? ` on ${cached.gpu.name}` : ""}`,
          `CPU encoder (libx265): ${yes(cached.encoders.libx265)}`,
          `E-AC3 audio: ${yes(cached.encoders.eac3)}`,
        ],
      };
    });

    ctx.routes((app) => {
      app.get<{ Querystring: { refresh?: string } }>("/encoders", async (request) => {
        const stale = !cached || Date.now() - Date.parse(cached.checkedAt) > REPORT_TTL_MS;
        return stale || request.query.refresh ? checkEncoders(ffmpegPath(ctx)) : cached;
      });

      app.post<{ Body: StartTestBody }>("/test", async (request, reply) => {
        const { slot, seconds = 20, force = false } = request.body ?? {};
        if (slot !== "gpu" && slot !== "cpu")
          return reply.code(400).send({ error: "slot must be gpu or cpu" });
        const clamped = Math.max(5, Math.min(600, Math.round(seconds)));
        return reply
          .code(202)
          .send(ctx.enqueue("test-encode", { slot, seconds: clamped }, { force }));
      });
    });
  },
});
