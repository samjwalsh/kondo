// Finds the x265 CRF that gives the same visual quality as the GPU's settings: clips from a few
// typical files are encoded both ways and compared with the original (SSIM).

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { JobContext } from "../../server/core/jobs.js";
import type { SettingsStore } from "../../server/core/settings.js";
import { videoArgs } from "./encode.js";
import type { Calibration, CalibrationPoint, CalibrationSample } from "./shared.js";
import type { LibraryStore } from "./store.js";

export const CALIBRATION_KEY = "cpuCalibration";
export const CRFS = [22, 25, 28, 31];
const CLIP_SECONDS = 60;

export interface CalibrateDeps {
  store: LibraryStore;
  settings: SettingsStore;
  workDir: string;
  /** For tests: shorter clips and fewer samples. */
  clipSeconds?: number;
  crfs?: number[];
}

/** By width, so a widescreen film with its black bars cropped still counts as 1080p. */
export function sizeClass(width: number): "1080p" | "720p" | "SD" {
  return width >= 1600 ? "1080p" : width >= 1100 ? "720p" : "SD";
}

/**
 * Typical files to test on: a high, typical and low bitrate 1080p, a 720p and an SD one, from
 * the files still to transcode (at least 3 minutes long).
 */
export function pickSamples(
  candidates: { id: number; width: number; kbps: number }[],
  durationOf: (id: number) => number,
): number[] {
  const longEnough = candidates.filter((c) => durationOf(c.id) >= 180);
  const near = (list: typeof longEnough, fraction: number) =>
    list.length === 0
      ? null
      : (list[Math.min(list.length - 1, Math.floor(list.length * fraction))] ?? null);
  const fullHd = longEnough.filter((c) => sizeClass(c.width) === "1080p");
  const hd = longEnough.filter((c) => sizeClass(c.width) === "720p");
  const sd = longEnough.filter((c) => sizeClass(c.width) === "SD");
  const picks = [
    near(fullHd, 0.9),
    near(fullHd, 0.5),
    near(fullHd, 0.1),
    near(hd, 0.5),
    near(sd, 0.5),
  ];
  return [...new Set(picks.filter((p) => p !== null).map((p) => p.id))];
}

/** Straight-line value of y at x, held at the ends. */
function interpolate(xs: number[], ys: number[], x: number): number {
  for (let i = 0; i < xs.length - 1; i++) {
    const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[i], ys[i + 1]] as [
      number,
      number,
      number,
      number,
    ];
    if (x >= x0 && x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return (x < (xs[0] ?? 0) ? ys[0] : ys.at(-1)) ?? 0;
}

/** Interpolates where `y` (falling as x rises) crosses `target`. */
function crossing(xs: number[], ys: number[], target: number): number | null {
  for (let i = 0; i < xs.length - 1; i++) {
    const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[i], ys[i + 1]] as [
      number,
      number,
      number,
      number,
    ];
    if (y0 >= target && y1 < target) return x0 + ((y0 - target) / (y0 - y1)) * (x1 - x0);
  }
  return null;
}

/** Works out the recommendation from the measurements. */
export function summarise(
  samples: CalibrationSample[],
  crfs: number[],
  preset: string,
): Calibration {
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const gpuSsimDb = mean(samples.map((s) => s.gpu.ssimDb));
  const cpuDb = crfs.map((crf) =>
    mean(samples.map((s) => s.cpu.find((c) => c.crf === crf)?.ssimDb ?? 0)),
  );
  let crf: number | null;
  let note: string | null = null;
  if (cpuDb.every((db) => db >= gpuSsimDb)) {
    crf = crfs.at(-1) ?? null;
    note = `Even CRF ${crf} looks at least as good as the GPU; a higher CRF may match it with smaller files.`;
  } else if (cpuDb.every((db) => db < gpuSsimDb)) {
    crf = null;
    note = `Even CRF ${crfs[0]} looks worse than the GPU, which is unexpected; the CPU slot shouldn't be used like this.`;
  } else {
    crf = crossing(crfs, cpuDb, gpuSsimDb);
  }
  // Half steps, rounded down: never worse than the GPU.
  const recommendedCrf = crf === null ? null : Math.floor(crf * 2) / 2;

  let sizeVsGpuPercent: number | null = null;
  let cpuSpeed: number | null = null;
  if (recommendedCrf !== null) {
    const crf = recommendedCrf;
    // Bitrate falls roughly exponentially with CRF, so interpolate logarithms.
    const at = (s: CalibrationSample, pick: (p: CalibrationPoint) => number) =>
      Math.exp(
        interpolate(
          s.cpu.map((c) => c.crf),
          s.cpu.map((c) => Math.log(pick(c))),
          crf,
        ),
      );
    sizeVsGpuPercent = Math.round(
      mean(samples.map((s) => at(s, (p) => p.kbps) / s.gpu.kbps - 1)) * 100,
    );
    cpuSpeed = Math.round(mean(samples.map((s) => at(s, (p) => p.speed))) * 100) / 100;
  }
  return {
    finishedAt: new Date().toISOString(),
    preset,
    crfs,
    samples,
    gpuSsimDb: Math.round(gpuSsimDb * 100) / 100,
    recommendedCrf,
    sizeVsGpuPercent,
    cpuSpeed,
    note,
  };
}

/** Reads ffmpeg's ssim filter summary: "SSIM Y:0.98 U:0.99 V:0.99 All:0.985 (18.24)". */
export function parseSsim(lines: string[]): number | null {
  for (const line of [...lines].reverse()) {
    const match = /SSIM .*All:[\d.]+ \(([\d.]+|inf)\)/.exec(line);
    if (match) return match[1] === "inf" ? 100 : Number(match[1]);
  }
  return null;
}

export async function runCalibration(
  job: JobContext<unknown>,
  deps: CalibrateDeps,
): Promise<Calibration> {
  const encoding = deps.settings.values("encoding");
  const ffmpeg = String(encoding.ffmpegPath);
  const preset = String(encoding.cpuPreset);
  const crfs = deps.crfs ?? CRFS;
  const clipSeconds = deps.clipSeconds ?? CLIP_SECONDS;
  const ids = pickSamples(
    deps.store.transcodeCandidatesByBitrate(),
    (id) => deps.store.detail(id)?.info?.durationS ?? 0,
  );
  if (ids.length === 0) throw new Error("No files to transcode that are long enough to test on");

  await rm(deps.workDir, { recursive: true, force: true });
  await mkdir(deps.workDir, { recursive: true });
  const steps = ids.length * (crfs.length + 1);
  let done = 0;
  const samples: CalibrationSample[] = [];
  try {
    for (const id of ids) {
      const file = deps.store.detail(id);
      const video = file?.info?.video;
      if (!file?.info || !video) continue;
      const source = path.join(file.root, file.path);
      const name = path.basename(file.path);
      const start = Math.round(file.info.durationS * 0.4);
      const tenBit = video.bitDepth > 8;
      const output = path.join(deps.workDir, "clip.mkv");

      /** Encodes the clip one way and measures it against the original. */
      const measure = async (
        encoder: "gpu" | "cpu",
        crf: number,
        label: string,
      ): Promise<CalibrationPoint> => {
        job.progress(done / steps, `${name}: ${label}`);
        const started = Date.now();
        const encode = await job.run(
          ffmpeg,
          [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-ss",
            String(start),
            "-i",
            source,
            "-t",
            String(clipSeconds),
            "-map",
            `0:${video.index}`,
            "-an",
            "-sn",
            "-dn",
            ...videoArgs(encoder, tenBit, {
              cpuThreads: Number(encoding.cpuThreads),
              cpuPreset: preset,
              cpuCrf: crf,
            }),
            output,
          ],
          { nice: encoder === "cpu" ? 19 : 10 },
        );
        if (encode.code !== 0) {
          throw new Error(`${label} failed: ${encode.stderrTail.slice(-2).join(" | ")}`);
        }
        const seconds = (Date.now() - started) / 1000;
        const bytes = (await stat(output)).size;
        const compare = await job.run(
          ffmpeg,
          [
            "-hide_banner",
            "-nostdin",
            "-i",
            output,
            "-ss",
            String(start),
            "-t",
            String(clipSeconds),
            "-i",
            source,
            "-lavfi",
            "[0:v]format=yuv420p,setpts=PTS-STARTPTS[a];[1:v]format=yuv420p,setpts=PTS-STARTPTS[b];[a][b]ssim",
            "-f",
            "null",
            "-",
          ],
          { nice: 19 },
        );
        const ssimDb = parseSsim(compare.stderrTail);
        if (compare.code !== 0 || ssimDb === null) {
          throw new Error(`Comparing ${label} failed: ${compare.stderrTail.slice(-2).join(" | ")}`);
        }
        done++;
        return {
          ssimDb,
          kbps: Math.round((bytes * 8) / clipSeconds / 1000),
          speed: Math.round((clipSeconds / seconds) * 100) / 100,
        };
      };

      const gpu = await measure("gpu", 0, "GPU (NVENC CQ 32)");
      const cpu: CalibrationSample["cpu"] = [];
      for (const crf of crfs) cpu.push({ crf, ...(await measure("cpu", crf, `CPU CRF ${crf}`)) });
      samples.push({
        fileId: id,
        name,
        label: `${sizeClass(video.width)}, ${((file.videoKbps ?? 0) / 1000).toFixed(1)} Mb/s`,
        clipStartS: start,
        clipSeconds,
        gpu,
        cpu,
      });
      job.log(
        `${name}: GPU ${(gpu.kbps / 1000).toFixed(2)} Mb/s at ${gpu.ssimDb} dB; CPU ${cpu
          .map((c) => `CRF ${c.crf} ${(c.kbps / 1000).toFixed(2)} Mb/s at ${c.ssimDb} dB`)
          .join(", ")}`,
      );
    }
  } finally {
    await rm(deps.workDir, { recursive: true, force: true });
  }

  const result = summarise(samples, crfs, preset);
  deps.store.setMeta(CALIBRATION_KEY, result);
  job.log(
    result.recommendedCrf === null
      ? `No CRF matched the GPU. ${result.note ?? ""}`
      : `CRF ${result.recommendedCrf} matches the GPU's quality with files ${Math.abs(result.sizeVsGpuPercent ?? 0)}% ${(result.sizeVsGpuPercent ?? 0) <= 0 ? "smaller" : "bigger"}, at ${result.cpuSpeed}× real time`,
  );
  return result;
}
