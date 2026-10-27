import { describe, expect, it } from "vitest";
import { parseSsim, pickSamples, summarise } from "../../src/tools/transcode/calibrate.js";
import type { CalibrationSample } from "../../src/tools/transcode/shared.js";

const CRFS = [22, 25, 28, 31];

/** A sample where the GPU sits at `gpuDb` and x265 falls 1 dB and loses ~30% bitrate per 3 CRF. */
function sample(id: number, gpuDb: number, gpuKbps: number): CalibrationSample {
  return {
    fileId: id,
    name: `file ${id}`,
    label: "1080p, 8.0 Mb/s",
    clipStartS: 600,
    clipSeconds: 60,
    gpu: { ssimDb: gpuDb, kbps: gpuKbps, speed: 6 },
    cpu: CRFS.map((crf, i) => ({
      crf,
      ssimDb: 19 - i,
      kbps: Math.round(2400 * 0.7 ** i),
      speed: 1.5,
    })),
  };
}

describe("CPU calibration", () => {
  it("recommends the highest CRF that still matches the GPU, in half steps", () => {
    // x265 hits 17.5 dB halfway between CRF 25 (18) and 28 (17): 26.5.
    const r = summarise([sample(1, 17.5, 1500), sample(2, 17.5, 1500)], CRFS, "medium");
    expect(r.recommendedCrf).toBe(26.5);
    expect(r.gpuSsimDb).toBe(17.5);
    // At CRF 26.5, x265 is ~1410 kb/s against the GPU's 1500: about 6% smaller.
    expect(r.sizeVsGpuPercent).toBe(-6);
    expect(r.cpuSpeed).toBe(1.5);
    expect(r.note).toBeNull();
  });

  it("rounds down, so the CPU is never worse than the GPU", () => {
    // 17.2 dB is crossed at CRF 27.4, which rounds down to 27.
    expect(summarise([sample(1, 17.2, 1500)], CRFS, "medium").recommendedCrf).toBe(27);
  });

  it("says so when every CRF tested beats the GPU, or none does", () => {
    const easy = summarise([sample(1, 10, 1500)], CRFS, "medium");
    expect(easy.recommendedCrf).toBe(31);
    expect(easy.note).toMatch(/higher CRF/);
    const hard = summarise([sample(1, 25, 1500)], CRFS, "medium");
    expect(hard.recommendedCrf).toBeNull();
    expect(hard.sizeVsGpuPercent).toBeNull();
  });

  it("reads ffmpeg's SSIM summary", () => {
    expect(
      parseSsim([
        "frame=  1440 fps=200",
        "[Parsed_ssim_4 @ 0x55] SSIM Y:0.985 (18.239) U:0.99 (20.1) V:0.99 (20.3) All:0.987 (18.861)",
      ]),
    ).toBe(18.861);
    expect(parseSsim(["SSIM Y:1 (inf) U:1 (inf) V:1 (inf) All:1.000000 (inf)"])).toBe(100);
    expect(parseSsim(["nothing here"])).toBeNull();
  });

  it("tests on high, typical and low bitrate 1080p, a 720p and an SD file, at least 3 minutes long", () => {
    const files = [
      ...Array.from({ length: 9 }, (_, i) => ({ id: i + 1, width: 1920, kbps: 1000 * (i + 1) })),
      // A cropped widescreen film is still 1080p.
      { id: 10, width: 1920, kbps: 10_000 },
      { id: 20, width: 1280, kbps: 3000 },
      { id: 30, width: 720, kbps: 1500 },
      { id: 31, width: 720, kbps: 1600 },
    ];
    const durations: Record<number, number> = { 10: 60 }; // too short
    const picked = pickSamples(files, (id) => durations[id] ?? 1500);
    // 1080p by bitrate: 90th percentile (9 Mb/s, since the 10 Mb/s one is too short), median
    // and 10th percentile; then the 720p and the median SD.
    expect(picked).toEqual([9, 5, 1, 20, 31]);
  });
});
