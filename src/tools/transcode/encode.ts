// Encoding one file: crop detection, the ffmpeg command built from the plan,
// checking the result, and comparison frames for the approval screen.
// Everything is written to Kondo's own work folder; the library isn't touched.
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { JobCancelledError, type JobContext } from "../../server/core/jobs.js";
import type { SettingsStore } from "../../server/core/settings.js";
import { errorMessage } from "../../server/integrations/http.js";
import { extractMediaInfo, type Probe } from "./media.js";
import { audioTarget, subtitleNeedsSrt } from "./rules.js";
import type { EncodeDetails, MediaInfo, Plan, VerifyReport } from "./shared.js";
import type { LibraryStore } from "./store.js";

export interface Crop {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface EncodeOptions {
  source: string;
  output: string;
  info: MediaInfo;
  plan: Plan;
  crop: Crop | null;
  encoder: "gpu" | "cpu";
  cpuThreads: number;
  /** x265 speed preset; tests use a fast one. */
  cpuPreset?: string;
  /** x265 CRF for the CPU slot. */
  cpuCrf?: number;
  version: string;
  now?: Date;
}

// mkvmerge's statistics tags describe the source streams and would be wrong on the new ones.
const STATISTICS_TAGS = [
  "BPS",
  "DURATION",
  "NUMBER_OF_FRAMES",
  "NUMBER_OF_BYTES",
  "_STATISTICS_WRITING_APP",
  "_STATISTICS_WRITING_DATE_UTC",
  "_STATISTICS_TAGS",
];

/** ffmpeg deletes a metadata key when it's given an empty value. */
function clearStatistics(stream: string): string[] {
  return STATISTICS_TAGS.flatMap((tag) => [
    `-metadata:s:${stream}`,
    `${tag}=`,
    `-metadata:s:${stream}`,
    `${tag}-eng=`,
  ]);
}

/** The video encoder settings, shared by real encodes and the CPU calibration. */
export function videoArgs(
  encoder: "gpu" | "cpu",
  tenBit: boolean,
  o: { cpuThreads: number; cpuPreset?: string; cpuCrf?: number },
): string[] {
  if (encoder === "gpu") {
    // Squish's settings: NVENC H.265, constant quality 32, "hq" preset.
    return [
      "-c:v",
      "hevc_nvenc",
      "-preset",
      "hq",
      "-rc",
      "vbr_hq",
      "-cq",
      "32",
      "-b:v",
      "0",
      "-profile:v",
      tenBit ? "main10" : "main",
      "-pix_fmt",
      tenBit ? "p010le" : "yuv420p",
    ];
  }
  return [
    "-c:v",
    "libx265",
    "-preset",
    o.cpuPreset ?? "medium",
    "-crf",
    String(o.cpuCrf ?? 28),
    "-x265-params",
    `pools=${o.cpuThreads}:log-level=error`,
    "-pix_fmt",
    tenBit ? "yuv420p10le" : "yuv420p",
  ];
}

/** The full ffmpeg command line for a plan (without the ffmpeg binary itself). */
export function buildEncodeArgs(o: EncodeOptions): string[] {
  const video = o.info.video;
  if (!video) throw new Error("The file has no video stream");
  const kept = o.plan.tracks.filter((t) => t.action !== "drop");
  const audio = kept.filter((t) => t.kind === "audio");
  const subtitles = kept.filter((t) => t.kind === "subtitle");
  const attachments = kept.filter((t) => t.kind === "attachment");
  const tenBit = video.bitDepth > 8;

  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-i",
    o.source,
    "-map",
    `0:${video.index}`,
  ];
  for (const t of [...audio, ...subtitles, ...attachments]) args.push("-map", `0:${t.index}`);
  args.push("-map_metadata", "0", "-map_chapters", "0");

  // Video ------------------------------------------------------------------------
  if (o.crop) args.push("-vf", `crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y}`);
  args.push(...videoArgs(o.encoder, tenBit, o));
  args.push("-disposition:v:0", "default", ...clearStatistics("v:0"));

  // Audio --------------------------------------------------------------------------
  audio.forEach((t, n) => {
    const a = o.info.audio.find((x) => x.index === t.index);
    if (!a) throw new Error(`Audio track ${t.index} is missing`);
    const target = audioTarget(a);
    if (target.copy) {
      args.push(`-c:a:${n}`, "copy");
    } else {
      args.push(
        `-c:a:${n}`,
        "eac3",
        `-b:a:${n}`,
        `${target.kbps}k`,
        `-ac:a:${n}`,
        String(target.channels),
        // The old title ("DTS-HD Master Audio / 5.1") would now be wrong.
        `-metadata:s:a:${n}`,
        "title=",
      );
    }
    args.push(`-disposition:a:${n}`, t.makeDefault ? "default" : "0", ...clearStatistics(`a:${n}`));
    if (t.setLanguage) args.push(`-metadata:s:a:${n}`, `language=${t.setLanguage}`);
  });

  // Subtitles ------------------------------------------------------------------------
  subtitles.forEach((t, n) => {
    const s = o.info.subtitles.find((x) => x.index === t.index);
    if (!s) throw new Error(`Subtitle track ${t.index} is missing`);
    args.push(`-c:s:${n}`, subtitleNeedsSrt(s.codec) ? "srt" : "copy");
    const flags = [
      s.isDefault ? "default" : "",
      s.forced ? "forced" : "",
      s.hearingImpaired ? "hearing_impaired" : "",
    ]
      .filter(Boolean)
      .join("+");
    args.push(`-disposition:s:${n}`, flags || "0", ...clearStatistics(`s:${n}`));
    if (t.setLanguage) args.push(`-metadata:s:s:${n}`, `language=${t.setLanguage}`);
  });

  if (attachments.length > 0) args.push("-c:t", "copy");

  // Kondo's marker, so it recognises its own files without its database.
  args.push(
    "-metadata",
    `KONDO=${o.version}`,
    "-metadata",
    `KONDO_SOURCE=${video.codec} ${video.width}x${video.height} ${o.info.sizeBytes} bytes`,
    "-metadata",
    `KONDO_DATE=${(o.now ?? new Date()).toISOString()}`,
    "-max_muxing_queue_size",
    "4096",
    "-f",
    "matroska",
    o.output,
  );
  return args;
}

// Black bars ---------------------------------------------------------------------------

export function parseCropLine(line: string): Crop | null {
  const m = line.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}

/**
 * Combines samples conservatively: keeps everything any sample saw as picture, so a dark
 * scene can't cause over-cropping. Returns null when there's nothing worth removing or the
 * result looks wrong.
 */
export function combineCrops(crops: Crop[], width: number, height: number): Crop | null {
  if (crops.length === 0) return null;
  let x = Math.min(...crops.map((c) => c.x));
  let y = Math.min(...crops.map((c) => c.y));
  x -= x % 2;
  y -= y % 2;
  const right = Math.min(width, Math.max(...crops.map((c) => c.x + c.width)));
  const bottom = Math.min(height, Math.max(...crops.map((c) => c.y + c.height)));
  let w = right - x;
  let h = bottom - y;
  w -= w % 2;
  h -= h % 2;
  if (width - w < 8 && height - h < 8) return null;
  if (w < width * 0.5 || h < height * 0.5) return null;
  return { width: w, height: h, x, y };
}

export async function detectCrop(
  job: JobContext<unknown>,
  ffmpeg: string,
  source: string,
  info: MediaInfo,
): Promise<Crop | null> {
  const video = info.video;
  if (!video || info.durationS < 120) return null;
  const crops: Crop[] = [];
  for (const at of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) {
    await job.checkpoint();
    const seen: { last: Crop | null } = { last: null };
    await job.run(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-ss",
        String(Math.floor(info.durationS * at)),
        "-i",
        source,
        "-t",
        "2",
        "-map",
        `0:${video.index}`,
        "-vf",
        "cropdetect=24:2:0",
        "-f",
        "null",
        "-",
      ],
      {
        nice: 10,
        timeoutMs: 120_000,
        onStderrLine: (line) => {
          seen.last = parseCropLine(line) ?? seen.last;
        },
      },
    );
    if (seen.last) crops.push(seen.last);
  }
  return combineCrops(crops, video.width, video.height);
}

// Checking the result ----------------------------------------------------------------------

/**
 * Whether a line from the decode check says something about the file. The throwaway "null"
 * output complains about repeated timestamps after seeking into some files ("non monotonically
 * increasing dts"); that's about where the check landed, not the file, which decodes cleanly.
 */
export function isDecodeProblem(line: string): boolean {
  return line.trim() !== "" && !line.startsWith("[null @");
}

export async function verifyOutput(
  job: JobContext<unknown>,
  tools: { ffmpeg: string; ffprobe: string },
  output: string,
  source: MediaInfo,
  plan: Plan,
  version: string,
): Promise<VerifyReport> {
  const lines: string[] = [];
  const probed = await job.run(
    tools.ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", output],
    { timeoutMs: 120_000, onStdoutLine: (line) => lines.push(line) },
  );
  const kept = plan.tracks.filter((t) => t.action !== "drop");
  const expected = {
    audio: kept.filter((t) => t.kind === "audio").length,
    subtitles: kept.filter((t) => t.kind === "subtitle").length,
  };
  if (probed.code !== 0) {
    return {
      ok: false,
      problems: ["ffprobe couldn't read the result"],
      sourceSeconds: source.durationS,
      outputSeconds: 0,
      audio: { expected: expected.audio, found: 0 },
      subtitles: { expected: expected.subtitles, found: 0 },
      videoCodec: null,
      decodeErrors: [],
    };
  }
  const out = extractMediaInfo(JSON.parse(lines.join("\n")) as Probe);
  const problems: string[] = [];
  const tolerance = Math.max(1, source.durationS * 0.005);
  if (Math.abs(out.durationS - source.durationS) > tolerance) {
    problems.push(
      `It's ${Math.round(out.durationS)} s long, the original ${Math.round(source.durationS)} s`,
    );
  }
  if (out.video?.codec !== "hevc")
    problems.push(`The video is ${out.video?.codec ?? "missing"}, not H.265`);
  if (out.audio.length !== expected.audio) {
    problems.push(`${out.audio.length} audio track(s), expected ${expected.audio}`);
  }
  if (out.subtitles.length !== expected.subtitles) {
    problems.push(`${out.subtitles.length} subtitle track(s), expected ${expected.subtitles}`);
  }
  if (out.kondoTag !== version) problems.push("Kondo's marker is missing");

  // Decode a few seconds at the start, middle and end.
  const decodeErrors: string[] = [];
  for (const at of [
    Math.min(10, out.durationS / 4),
    out.durationS / 2,
    Math.max(0, out.durationS - 30),
  ]) {
    await job.checkpoint();
    const errors: string[] = [];
    await job.run(
      tools.ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-ss",
        at.toFixed(1),
        "-i",
        output,
        "-t",
        "5",
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-f",
        "null",
        "-",
      ],
      {
        nice: 10,
        timeoutMs: 120_000,
        onStderrLine: (line) => {
          if (isDecodeProblem(line)) errors.push(line);
        },
      },
    );
    decodeErrors.push(...errors.slice(0, 3));
  }
  if (decodeErrors.length > 0) problems.push(`It doesn't play cleanly: ${decodeErrors[0]}`);

  return {
    ok: problems.length === 0,
    problems,
    sourceSeconds: source.durationS,
    outputSeconds: out.durationS,
    audio: { expected: expected.audio, found: out.audio.length },
    subtitles: { expected: expected.subtitles, found: out.subtitles.length },
    videoCodec: out.video?.codec ?? null,
    decodeErrors,
  };
}

/** Two frames from the original and the result at the same moments, for comparing by eye. */
export async function saveFrames(
  job: JobContext<unknown>,
  ffmpeg: string,
  files: { source: string; output: string },
  crop: Crop | null,
  durationS: number,
  dir: string,
): Promise<number[]> {
  const times = [0.3, 0.62].map((f) => Math.floor(durationS * f));
  for (const [i, at] of times.entries()) {
    const sources: [string, string, string][] = [
      [
        "source",
        files.source,
        `${crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` : ""}scale=960:-2`,
      ],
      ["output", files.output, "scale=960:-2"],
    ];
    for (const [name, file, filters] of sources) {
      await job.run(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-ss",
          String(at),
          "-i",
          file,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          filters,
          "-q:v",
          "3",
          path.join(dir, `frame-${name}-${i}.jpg`),
        ],
        { nice: 10, timeoutMs: 120_000 },
      );
    }
  }
  return times;
}

// The job ----------------------------------------------------------------------------------

export interface EncodePayload {
  fileId: number;
  name: string;
  /** Which slot encodes it (older jobs: the GPU). */
  encoder?: "gpu" | "cpu";
}

export interface EncodeDeps {
  store: LibraryStore;
  settings: SettingsStore;
  workRoot: string;
  version: string;
  /** Used when the job doesn't say. */
  encoder?: "gpu" | "cpu";
  /** For tests: a faster x265 preset. */
  cpuPreset?: string;
  /** Called when the job ends, however it ends (the feeder tops up the queue). */
  onFinished?: () => void;
}

export interface EncodeResult {
  status: "awaiting-approval" | "not-worth-it" | "skipped";
  savingPercent?: number;
}

export function workDirFor(workRoot: string, fileId: number): string {
  return path.join(workRoot, String(fileId));
}

function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export async function runEncode(
  job: JobContext<EncodePayload>,
  deps: EncodeDeps,
): Promise<EncodeResult> {
  const { fileId } = job.payload;
  try {
    const file = deps.store.detail(fileId);
    if (!file?.info?.video || !file.plan || file.decision !== "transcode") {
      job.log("This file isn't marked for transcoding any more; nothing to do");
      return { status: "skipped" };
    }
    const source = path.join(file.root, file.path);
    const recorded = deps.store.sourceState(fileId);
    const current = await stat(source).catch(() => null);
    if (!current) throw new Error("The file is gone");
    if (
      !recorded ||
      current.size !== recorded.size ||
      Math.round(current.mtimeMs) !== recorded.mtimeMs
    ) {
      throw new Error("The file changed since it was scanned; the next scan will look at it again");
    }

    const encoding = deps.settings.values("encoding");
    const tools = { ffmpeg: String(encoding.ffmpegPath), ffprobe: String(encoding.ffprobePath) };
    const minSaving = Number(deps.settings.values("transcode").minSavingsPercent);
    const encoder = job.payload.encoder ?? deps.encoder ?? "gpu";
    const cpuCrf = Number(encoding.cpuCrf);
    const cpuPreset = deps.cpuPreset ?? String(encoding.cpuPreset);
    if (encoder === "cpu" && !(cpuCrf > 0)) {
      throw new Error("The CPU encoder isn't calibrated yet (Settings → Encoders → CPU quality)");
    }
    const encoderName = encoder === "gpu" ? "hevc_nvenc" : `libx265 (CRF ${cpuCrf}, ${cpuPreset})`;
    const workDir = workDirFor(deps.workRoot, fileId);
    const output = path.join(workDir, "output.mkv");
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });

    try {
      job.progress(null, "Checking for black bars…");
      const crop = await detectCrop(job, tools.ffmpeg, source, file.info);
      if (crop) {
        job.log(
          `Cropping black bars: ${file.info.video.width}×${file.info.video.height} → ${crop.width}×${crop.height}`,
        );
      }

      const args = buildEncodeArgs({
        source,
        output,
        info: file.info,
        plan: file.plan,
        crop,
        encoder,
        cpuThreads: Number(encoding.cpuThreads),
        cpuPreset,
        cpuCrf,
        version: deps.version,
      });
      job.log(`Encoding with ${encoderName}`);
      const started = Date.now();
      const totalUs = file.info.durationS * 1_000_000;
      const fpsSamples: number[] = [];
      const live = { fps: 0, speed: "" };
      const result = await job.run(tools.ffmpeg, args, {
        // The CPU slot shares the processor with Plex: lowest priority.
        nice: encoder === "cpu" ? 19 : 10,
        onStdoutLine: (line) => {
          const [key, value = ""] = line.split("=");
          if (key === "fps") {
            live.fps = Number(value) || 0;
            if (live.fps > 0) fpsSamples.push(live.fps);
          } else if (key === "speed") {
            live.speed = value.trim();
          } else if (
            (key === "out_time_us" || key === "out_time_ms") &&
            /^\d+$/.test(value) &&
            totalUs > 0
          ) {
            const fraction = Math.min(1, Number(value) / totalUs);
            const left =
              fraction > 0.01 ? ((Date.now() - started) / fraction) * (1 - fraction) : null;
            job.progress(
              fraction,
              [
                `${live.fps.toFixed(0)} fps`,
                live.speed,
                left !== null ? `${formatDuration(left)} left` : "",
              ]
                .filter(Boolean)
                .join(" · "),
            );
          }
        },
      });
      if (result.code !== 0) {
        throw new Error(
          `ffmpeg failed: ${result.stderrTail.slice(-3).join(" | ") || `exit code ${result.code}`}`,
        );
      }
      const encodeSeconds = Math.round((Date.now() - started) / 1000);
      const outputBytes = (await stat(output)).size;

      job.progress(null, "Checking the result…");
      const verify = await verifyOutput(job, tools, output, file.info, file.plan, deps.version);
      if (!verify.ok)
        throw new Error(`The result failed its checks: ${verify.problems.join("; ")}`);

      const savingPercent = Math.round((1 - outputBytes / current.size) * 100);
      const details: EncodeDetails = {
        encoder: encoderName,
        encodeSeconds,
        averageFps:
          fpsSamples.length > 0
            ? Math.round(fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length)
            : null,
        crop: crop
          ? `${file.info.video.width}×${file.info.video.height} → ${crop.width}×${crop.height}`
          : null,
        sourceBytes: current.size,
        outputBytes,
        savingPercent,
        verify,
        frames: [],
      };

      if (savingPercent < minSaving) {
        await rm(workDir, { recursive: true, force: true });
        deps.store.saveOutcome(fileId, {
          status: "not-worth-it",
          encoder: encoderName,
          outputBytes,
          details,
          error: `Tried: only ${savingPercent}% smaller (needs at least ${minSaving}%)`,
        });
        job.log(`Only ${savingPercent}% smaller, so the original stays`);
        return { status: "not-worth-it", savingPercent };
      }

      job.progress(null, "Saving comparison frames…");
      details.frames = await saveFrames(
        job,
        tools.ffmpeg,
        { source, output },
        crop,
        file.info.durationS,
        workDir,
      );
      deps.store.saveOutcome(fileId, {
        status: "awaiting-approval",
        encoder: encoderName,
        outputPath: output,
        outputBytes,
        details,
      });
      job.log(
        `${formatBytes(current.size)} → ${formatBytes(outputBytes)} (${savingPercent}% smaller) in ${formatDuration(encodeSeconds * 1000)}. Waiting for approval.`,
      );
      return { status: "awaiting-approval", savingPercent };
    } catch (error) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error instanceof JobCancelledError) {
      // Cancelled by a person: don't offer this file again until it's re-queued by hand.
      if (job.signal.reason === "cancel") {
        deps.store.saveOutcome(fileId, { status: "rejected", error: "Cancelled while encoding" });
      }
    } else {
      deps.store.saveOutcome(fileId, { status: "failed", error: errorMessage(error) });
    }
    throw error;
  } finally {
    deps.onFinished?.();
  }
}
