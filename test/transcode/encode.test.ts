import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../../src/server/core/db.js";
import { EventBus } from "../../src/server/core/events.js";
import type { JobContext } from "../../src/server/core/jobs.js";
import { runProcess } from "../../src/server/core/process.js";
import { encodingSettings } from "../../src/server/core/schedule.js";
import { SettingsStore } from "../../src/server/core/settings.js";
import type { Integrations } from "../../src/server/core/tools.js";
import {
  buildEncodeArgs,
  combineCrops,
  type EncodePayload,
  parseCropLine,
  runEncode,
} from "../../src/tools/transcode/encode.js";
import { extractMediaInfo } from "../../src/tools/transcode/media.js";
import { evaluate } from "../../src/tools/transcode/rules.js";
import { runScan } from "../../src/tools/transcode/scan.js";
import { transcodeSettings } from "../../src/tools/transcode/server.js";
import { LibraryStore, migrations } from "../../src/tools/transcode/store.js";
import { tempDir } from "../helpers.js";
import { audio, probe, subtitle, video } from "./fixtures.js";

const RULES = { threshold1080Mbps: 4.5, threshold720Mbps: 1.6, thresholdSdMbps: 0.8 };

/** Value following a flag, e.g. valueAfter("-c:a:0") → "eac3". */
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("ffmpeg command", () => {
  const info = extractMediaInfo(
    probe([
      video("h264", 1920, 1080, { tags: { BPS: "22910550" } }),
      audio("dts", 6, "eng", "DTS-HD Master Audio / 5.1", {
        profile: "DTS-HD MA",
        isDefault: true,
      }),
      audio("ac3", 2, "eng", "Commentary"),
      audio("aac", 2, undefined, undefined, { bit_rate: "160000" }),
      subtitle("hdmv_pgs_subtitle", "eng", "SDH"),
      subtitle("subrip", "eng", "Forced", { forced: true }),
      subtitle("subrip", "spa"),
    ]),
  );
  const plan = evaluate(info, "eng", RULES).plan;
  if (!plan) throw new Error("expected a plan");
  const args = buildEncodeArgs({
    source: "/lib/in.mkv",
    output: "/work/1/output.mkv",
    info,
    plan,
    crop: { width: 1920, height: 800, x: 0, y: 140 },
    encoder: "gpu",
    cpuThreads: 16,
    version: "abc123",
    now: new Date("2026-10-27T03:00:00Z"),
  });

  it("maps only the kept tracks, in order", () => {
    const maps = args.flatMap((a, i) => (a === "-map" ? [args[i + 1]] : []));
    // video, DTS (converted), unlabelled AAC (kept to be safe), SDH and forced English subs.
    expect(maps).toEqual(["0:0", "0:1", "0:3", "0:4", "0:5"]);
  });

  it("encodes video like Squish did, cropped", () => {
    expect(valueAfter(args, "-c:v")).toBe("hevc_nvenc");
    expect(valueAfter(args, "-preset")).toBe("hq");
    expect(valueAfter(args, "-cq")).toBe("32");
    expect(valueAfter(args, "-vf")).toBe("crop=1920:800:0:140");
  });

  it("converts the DTS track to E-AC3 5.1, drops its old title, and makes it the default", () => {
    expect(valueAfter(args, "-c:a:0")).toBe("eac3");
    expect(valueAfter(args, "-b:a:0")).toBe("640k");
    expect(valueAfter(args, "-ac:a:0")).toBe("6");
    expect(args).toContain("title=");
    expect(valueAfter(args, "-disposition:a:0")).toBe("default");
    expect(valueAfter(args, "-c:a:1")).toBe("copy");
    expect(valueAfter(args, "-disposition:a:1")).toBe("0");
  });

  it("keeps subtitle flags and clears stale bitrate statistics", () => {
    expect(valueAfter(args, "-disposition:s:0")).toBe("hearing_impaired");
    expect(valueAfter(args, "-disposition:s:1")).toBe("forced");
    expect(args.filter((a) => a === "BPS-eng=").length).toBe(5); // every output stream
  });

  it("marks the file as Kondo's", () => {
    expect(args).toContain("KONDO=abc123");
    expect(args.at(-1)).toBe("/work/1/output.mkv");
  });
});

describe("black bars", () => {
  it("parses cropdetect output", () => {
    expect(parseCropLine("[Parsed_cropdetect_0 @ 0x1] x1:0 x2:1919 crop=1920:800:0:140")).toEqual({
      width: 1920,
      height: 800,
      x: 0,
      y: 140,
    });
    expect(parseCropLine("frame=  50 fps=0.0")).toBeNull();
  });

  it("keeps everything any sample saw, and ignores tiny or suspicious crops", () => {
    expect(
      combineCrops(
        [
          { width: 1920, height: 800, x: 0, y: 140 },
          { width: 1920, height: 816, x: 0, y: 132 },
        ],
        1920,
        1080,
      ),
    ).toEqual({ width: 1920, height: 816, x: 0, y: 132 });
    expect(combineCrops([{ width: 1920, height: 1076, x: 0, y: 2 }], 1920, 1080)).toBeNull();
    expect(combineCrops([{ width: 1920, height: 200, x: 0, y: 440 }], 1920, 1080)).toBeNull();
    expect(combineCrops([], 1920, 1080)).toBeNull();
  });
});

// End to end ------------------------------------------------------------------------------

const hasFfmpeg = (() => {
  try {
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      stdio: "pipe",
    }).toString();
    return ["libx264", "libx265", "flac", "eac3"].every((e) => encoders.includes(` ${e} `));
  } catch {
    return false;
  }
})();

/** 130 s, letterboxed 640×272 picture in 640×360, five audio/subtitle tracks. */
function makeLetterboxedVideo(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const srt = (lang: string) => {
    const p = `${file}.${lang}.srt`;
    execFileSync("sh", ["-c", `printf '1\\n00:00:01,000 --> 00:00:03,000\\n${lang}\\n' > '${p}'`]);
    return p;
  };
  const tone = (n: number) => Array.from({ length: n }, () => "sin(440*2*PI*t)").join("|");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x272:rate=25:duration=130",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${tone(6)}:s=48000:d=130:c=5.1`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${tone(2)}:s=48000:d=130:c=stereo`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${tone(2)}:s=48000:d=130:c=stereo`,
    "-i",
    srt("eng"),
    "-i",
    srt("ger"),
    "-map",
    "0",
    "-map",
    "1",
    "-map",
    "2",
    "-map",
    "3",
    "-map",
    "4",
    "-map",
    "5",
    "-vf",
    "pad=640:360:0:44:black",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-b:v",
    "4M",
    "-c:a:0",
    "flac",
    "-c:a:1",
    "aac",
    "-c:a:2",
    "aac",
    "-c:s",
    "srt",
    "-metadata:s:a:0",
    "language=eng",
    "-disposition:a:0",
    "default",
    "-metadata:s:a:1",
    "language=eng",
    "-metadata:s:a:2",
    "language=fre",
    "-metadata:s:s:0",
    "language=eng",
    "-metadata:s:s:1",
    "language=ger",
    file,
  ]);
}

function fakeJob(payload: EncodePayload): JobContext<EncodePayload> {
  return {
    id: 1,
    payload,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    checkpoint: async () => {},
    run: (command, args, options) => runProcess(command, args, options),
  };
}

const integrations = {
  sonarr: { configured: () => false, app: "sonarr", name: "Sonarr" },
  radarr: { configured: () => false, app: "radarr", name: "Radarr" },
} as unknown as Integrations;

describe.skipIf(!hasFfmpeg)("encoding a file (needs ffmpeg with x264/x265)", () => {
  it("encodes, checks and saves frames — leaving the library untouched", async () => {
    const library = tempDir("kondo-lib-");
    const source = path.join(library, "Show", "Show - S01E01.mkv");
    makeLetterboxedVideo(source);
    const before = execFileSync("sha256sum", [source]).toString();

    const db = openDb(tempDir());
    migrate(db, "core", coreMigrations);
    migrate(db, "tool:transcode", migrations);
    const settings = new SettingsStore(db, new EventBus());
    settings.register(encodingSettings);
    settings.register(transcodeSettings);
    settings.update("transcode", { roots: library, minSavingsPercent: 1 });
    settings.update("encoding", { cpuThreads: 4 });
    const store = new LibraryStore(db);
    await runScan({ ...fakeJob({ fileId: 0, name: "" }), payload: {} } as JobContext<unknown>, {
      store,
      settings,
      integrations,
    });
    const [file] = store.page({ filter: "transcode", sort: "path", limit: 5, offset: 0 }).files;
    expect(file).toBeDefined();
    const id = file?.id ?? 0;

    const workRoot = tempDir("kondo-work-");
    const deps = {
      store,
      settings,
      workRoot,
      version: "test",
      encoder: "cpu" as const,
      cpuPreset: "ultrafast",
    };
    const result = await runEncode(fakeJob({ fileId: id, name: "Show - S01E01.mkv" }), deps);
    expect(result.status).toBe("awaiting-approval");

    const outcome = store.outcome(id);
    expect(outcome?.status).toBe("awaiting-approval");
    expect(outcome?.details?.crop).toBe("640×360 → 640×272");
    expect(outcome?.details?.verify.ok).toBe(true);
    for (const kind of ["source", "output"]) {
      for (const i of [0, 1])
        expect(existsSync(path.join(workRoot, String(id), `frame-${kind}-${i}.jpg`))).toBe(true);
    }

    const out = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path.join(workRoot, String(id), "output.mkv"),
      ]).toString(),
    );
    const streams = out.streams as {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      channels?: number;
      tags?: Record<string, string>;
    }[];
    expect(streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual([
      "video:hevc",
      "audio:eac3",
      "subtitle:subrip",
    ]);
    expect(streams[0]).toMatchObject({ width: 640, height: 272 });
    expect(streams[1]).toMatchObject({ channels: 6 });
    expect(streams[2]?.tags?.language).toBe("eng");
    expect(Object.entries(out.format.tags).find(([k]) => k.toLowerCase() === "kondo")?.[1]).toBe(
      "test",
    );

    // The original is untouched, and the result waits for approval.
    expect(execFileSync("sha256sum", [source]).toString()).toBe(before);
    expect(store.approvals().map((a) => a.file.id)).toEqual([id]);
    expect(store.nextCandidates(5)).toEqual([]);

    // Raising the bar above what this encode achieved: now it's "not worth it", the file is
    // skipped, and its work folder is gone. (Skipped if this ffmpeg shrinks the test video
    // by 90% or more, the highest bar the setting allows.)
    const saving = store.outcome(id)?.details?.savingPercent ?? 100;
    if (saving < 90) {
      settings.update("transcode", { minSavingsPercent: 90 });
      store.saveOutcome(id, { status: "failed", error: "reset for the test" });
      const again = await runEncode(fakeJob({ fileId: id, name: "x" }), deps);
      expect(again.status).toBe("not-worth-it");
      expect(store.detail(id)).toMatchObject({ decision: "skip", reasonCode: "not-worth-it" });
      expect(existsSync(path.join(workRoot, String(id)))).toBe(false);
    }
  }, 120_000);
});
