import { describe, expect, it } from "vitest";
import { languageFromName, normalizeLanguage } from "../../src/tools/transcode/languages.js";
import { extractMediaInfo } from "../../src/tools/transcode/media.js";
import { evaluate, type RuleSettings, resolutionOf } from "../../src/tools/transcode/rules.js";
import type { PlannedTrack } from "../../src/tools/transcode/shared.js";
import { attachment, audio, probe, subtitle, video } from "./fixtures.js";

const RULES: RuleSettings = { threshold1080Mbps: 3.5, threshold720Mbps: 1.6, thresholdSdMbps: 0.8 };

function run(p: ReturnType<typeof probe>, originalLanguage: string | null = "eng") {
  return evaluate(extractMediaInfo(p), originalLanguage, RULES);
}

/** "action:to" per track index, e.g. { 1: "convert:E-AC3 5.1 · 640 kb/s", 2: "drop" }. */
function actions(tracks: PlannedTrack[]) {
  return Object.fromEntries(tracks.map((t) => [t.index, t.to ? `${t.action}:${t.to}` : t.action]));
}

describe("languages", () => {
  it("normalises tags and names", () => {
    expect(normalizeLanguage("en")).toBe("eng");
    expect(normalizeLanguage("fra")).toBe("fre");
    expect(normalizeLanguage("ENG")).toBe("eng");
    expect(normalizeLanguage("und")).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
    expect(languageFromName("Portuguese (Brazil)")).toBe("por");
    expect(languageFromName("Japanese")).toBe("jpn");
    expect(languageFromName("Any")).toBeNull();
  });
});

describe("resolution", () => {
  it("treats letterboxed and 4:3 1080p as 1080p", () => {
    expect(resolutionOf(1920, 800)).toBe("1080p");
    expect(resolutionOf(1440, 1080)).toBe("1080p");
    expect(resolutionOf(1280, 720)).toBe("720p");
    expect(resolutionOf(854, 480)).toBe("sd");
    expect(resolutionOf(3840, 1600)).toBe("above-1080p");
  });
});

describe("decisions", () => {
  it("transcodes a Blu-ray remux, converts lossless audio and drops an unflagged commentary", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "22910550" } }),
        audio("dts", 6, "eng", "DTS-HD Master Audio / 5.1", {
          profile: "DTS-HD MA",
          isDefault: true,
          bps: 3634381,
        }),
        audio("ac3", 2, "eng", "Commentary by Cast and Crew", { bit_rate: "192000" }),
        subtitle("hdmv_pgs_subtitle", "eng", "SDH", {
          tags: { language: "eng", title: "SDH", BPS: "50751" },
        }),
      ]),
    );
    expect(r).toMatchObject({ decision: "transcode", reasonCode: "h264" });
    expect(actions(r.plan?.tracks ?? [])).toEqual({
      1: "convert:E-AC3 5.1 · 640 kb/s",
      2: "drop",
      3: "keep",
    });
    expect(r.plan?.tracks.find((t) => t.index === 2)?.reason).toBe("Commentary");
    expect(r.plan?.tracks.find((t) => t.index === 1)?.makeDefault).toBe(true);
    // ≈ (1.5 + 0.64 + 0.05) Mb/s for 2600 s, far below 8 GB.
    expect(r.plan?.estimatedBytes).toBeLessThan(800_000_000);
  });

  it("keeps English over a default foreign dub, and moves the default", () => {
    const r = run(
      probe(
        [
          video("h264", 1920, 1040),
          audio("ac3", 6, "rus", "Dub", { isDefault: true, bit_rate: "448000" }),
          audio("ac3", 2, "rus", "MVO", { bit_rate: "384000" }),
          audio("dts", 6, "eng", "DTS 5.1", { profile: "DTS", bit_rate: "1536000" }),
          subtitle("subrip", "rus"),
          subtitle("subrip", "rus"),
          subtitle("subrip", "eng"),
        ],
        { duration: "6600", size: "8900000000", bit_rate: "10785000" },
      ),
    );
    expect(r.decision).toBe("transcode");
    expect(actions(r.plan?.tracks ?? [])).toEqual({
      1: "drop",
      2: "drop",
      3: "convert:E-AC3 5.1 · 640 kb/s",
      4: "drop",
      5: "drop",
      6: "keep",
    });
    expect(r.plan?.tracks.find((t) => t.index === 1)?.reason).toBe("Russian, not English");
    expect(r.plan?.notes.join(" ")).toMatch(/Default audio changes to: English · DTS 5\.1/);
  });

  it("leaves efficient H.265 alone but re-encodes a big one", () => {
    const small = run(
      probe([video("hevc", 1920, 1080, { pix_fmt: "yuv420p10le" }), audio("eac3", 6, "eng")], {
        duration: "2578",
        size: "610000000",
        bit_rate: "1879000",
      }),
    );
    expect(small).toMatchObject({ decision: "skip", reasonCode: "already-efficient" });
    const big = run(
      probe([video("hevc", 1920, 1080, { tags: { BPS: "9000000" } }), audio("eac3", 6, "eng")]),
    );
    expect(big).toMatchObject({ decision: "transcode", reasonCode: "h265-high-bitrate" });
    expect(big.plan?.video.to).toBe("H.265 8-bit · ≈1.5 Mb/s");
  });

  it("keeps the original language and English for a foreign film, original as default", () => {
    const r = run(
      probe([
        video("h264", 1920, 800, { tags: { BPS: "12000000" } }),
        audio("ac3", 6, "kor", undefined, { isDefault: true }),
        audio("ac3", 6, "eng", "English dub"),
        subtitle("subrip", "eng", "Forced", { forced: true }),
        subtitle("subrip", "eng"),
        subtitle("subrip", "kor"),
      ]),
      "kor",
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({
      1: "keep",
      2: "keep",
      3: "keep",
      4: "keep",
      5: "drop",
    });
    expect(r.plan?.tracks.find((t) => t.index === 1)?.makeDefault).toBe(true);
    expect(r.plan?.notes).toEqual([]);
  });

  it("is fine with a foreign film that has no English at all, and says so", () => {
    const r = run(
      probe([video("h264", 1920, 1080, { tags: { BPS: "9000000" } }), audio("ac3", 6, "fre")]),
      "fre",
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({ 1: "keep" });
    expect(r.plan?.notes.join(" ")).toMatch(/No English audio or subtitles/);
  });

  it("keeps everything it can't identify", () => {
    const r = run(
      probe([
        video("h264", 1280, 720, { tags: { BPS: "5000000" } }),
        audio("aac", 2, "und"),
        audio("aac", 2),
        subtitle("subrip"),
      ]),
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({ 1: "keep", 2: "keep", 3: "keep" });
  });

  it("falls back to the main track when no audio is English, unlabelled or original", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "9000000" } }),
        audio("ac3", 6, "spa", undefined, { isDefault: true }),
        audio("ac3", 2, "ger"),
      ]),
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({ 1: "keep", 2: "drop" });
    expect(r.plan?.tracks[0]?.reason).toMatch(/keeping the main track/);
  });

  it("keeps anime styled subtitles with their fonts, converts FLAC, drops cover art", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "8000000" } }),
        audio("flac", 2, "jpn", undefined, { isDefault: true }),
        audio("aac", 2, "eng"),
        subtitle("ass", "eng", "Signs & Songs", { forced: true }),
        subtitle("ass", "eng", "Full"),
        attachment("Font1.ttf", "application/x-truetype-font"),
        attachment("Font2.otf", "font/otf"),
        video("mjpeg", 600, 900, { disposition: { attached_pic: 1 } }),
      ]),
      "jpn",
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({
      1: "convert:E-AC3 stereo · 224 kb/s",
      2: "keep",
      3: "keep",
      4: "keep",
      5: "keep",
      6: "keep",
      7: "drop",
    });
  });

  it("drops audio description and other-language subtitles", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "9000000" } }),
        audio("eac3", 6, "eng", undefined, { isDefault: true }),
        audio("eac3", 2, "eng", "Audio Description"),
        subtitle("subrip", "spa"),
      ]),
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({ 1: "keep", 2: "drop", 3: "drop" });
    expect(r.plan?.tracks.find((t) => t.index === 2)?.reason).toBe("Audio description");
  });

  it("converts 7.1 TrueHD Atmos to 5.1 and notes the lost Atmos", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "25000000" } }),
        audio("truehd", 8, "eng", "TrueHD Atmos 7.1", { isDefault: true }),
      ]),
    );
    expect(actions(r.plan?.tracks ?? [])[1]).toBe("convert:E-AC3 5.1 (from 7.1) · 640 kb/s");
    expect(r.plan?.notes.join(" ")).toMatch(/Atmos is lost/);
  });

  it("converts MP4 text subtitles to SRT", () => {
    const r = run(
      probe(
        [
          video("h264", 1920, 1080, { bit_rate: "6000000" }),
          audio("aac", 2, "eng"),
          subtitle("mov_text", "eng"),
        ],
        { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      ),
    );
    expect(actions(r.plan?.tracks ?? [])[2]).toBe("convert:SRT");
  });

  it("skips what it doesn't handle or has already done", () => {
    expect(run(probe([video("hevc", 3840, 2160)])).reasonCode).toBe("above-1080p");
    expect(
      run(probe([video("hevc", 1920, 1080, { color_transfer: "smpte2084" })])).reasonCode,
    ).toBe("hdr");
    expect(
      run(
        probe([
          video("hevc", 1920, 1080, {
            side_data_list: [{ side_data_type: "DOVI configuration record" }],
          }),
        ]),
      ).reason,
    ).toBe("Dolby Vision isn't handled yet");
    expect(run(probe([audio("aac", 2, "eng")])).reasonCode).toBe("no-video");
    expect(run(probe([video("hevc", 1920, 1080)], { tags: { KONDO: "0.1.0" } })).reasonCode).toBe(
      "kondo-done",
    );
    expect(evaluate(null, null, RULES).decision).toBe("error");
  });

  it("skips a file that would barely shrink", () => {
    const r = run(
      probe(
        [
          video("h264", 1920, 1080, { bit_rate: "1300000" }),
          audio("aac", 2, "eng", undefined, { bit_rate: "160000" }),
        ],
        {
          duration: "1300",
          size: "240000000",
        },
      ),
    );
    expect(r).toMatchObject({ decision: "skip", reasonCode: "small-saving" });
  });
});

describe("media info", () => {
  it("estimates the video bitrate when the file doesn't record it", () => {
    const info = extractMediaInfo(
      probe([video("hevc", 1920, 1080), audio("eac3", 6, "eng")], { bit_rate: "1879000" }),
    );
    expect(info.video).toMatchObject({ kbps: 1879 - 640, kbpsEstimated: true });
  });

  it("reads bit depth, HDR, flags from titles, and ignores cover art as video", () => {
    const info = extractMediaInfo(
      probe([
        video("mjpeg", 600, 900, { disposition: { attached_pic: 1 } }),
        video("hevc", 1920, 1080, { pix_fmt: "yuv420p10le", color_transfer: "arib-std-b67" }),
        subtitle("subrip", "eng", "English SDH"),
      ]),
    );
    expect(info.video).toMatchObject({ codec: "hevc", bitDepth: 10, hdr: "hlg" });
    expect(info.subtitles[0]?.hearingImpaired).toBe(true);
    expect(info.attachments).toHaveLength(1);
  });
});

describe("missing language tags", () => {
  it("reads a language from the title and writes it into the new file", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "9000000" } }),
        audio("eac3", 6),
        subtitle("subrip", undefined, "English [CC]"),
      ]),
    );
    const sub = r.plan?.tracks.find((t) => t.kind === "subtitle");
    expect(sub).toMatchObject({ action: "keep", setLanguage: "eng" });
    expect(sub?.reason).toMatch(/going by its title/);
    // The lone unlabelled audio track of an English show is labelled English, and there's no warning.
    expect(r.plan?.tracks.find((t) => t.kind === "audio")).toMatchObject({
      action: "keep",
      setLanguage: "eng",
    });
    expect(r.plan?.notes).toEqual([]);
  });

  it("doesn't guess when several audio tracks are unlabelled", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "9000000" } }),
        audio("aac", 2),
        audio("aac", 2),
      ]),
    );
    expect(r.plan?.tracks.filter((t) => t.setLanguage)).toEqual([]);
  });

  it("keeps a lone track flagged as audio description, and says why", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "9000000" } }),
        audio("ac3", 2, undefined, undefined, { disposition: { visual_impaired: 1 } }),
      ]),
    );
    expect(r.plan?.tracks[0]).toMatchObject({ action: "keep" });
    expect(r.plan?.tracks[0]?.reason).toMatch(
      /The only audio track \(marked as audio description\)/,
    );
  });
});

describe("forced subtitles", () => {
  it("keeps English forced subtitles but drops another language's", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "9000000" } }),
        audio("eac3", 6, "ita"),
        audio("eac3", 6, "eng", undefined, { isDefault: true }),
        subtitle("subrip", "ita", "Forced", { forced: true }),
        subtitle("subrip", "eng", "Forced", { forced: true }),
      ]),
    );
    expect(actions(r.plan?.tracks ?? [])).toMatchObject({ 3: "drop", 4: "keep" });
    expect(r.plan?.tracks.find((t) => t.index === 3)?.reason).toMatch(/Italian forced subtitles/);
  });
});

describe("one audio track per language", () => {
  it("keeps the TrueHD mix and drops the AC3 copy of it", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "30000000" } }),
        audio("truehd", 6, "eng", undefined, { isDefault: true }),
        audio("ac3", 6, "eng", "AC-3 5.1", { bit_rate: "640000" }),
      ]),
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({ 1: "convert:E-AC3 5.1 · 640 kb/s", 2: "drop" });
    expect(r.plan?.tracks.find((t) => t.index === 2)?.reason).toBe(
      "Another English track is kept (TrueHD 5.1)",
    );
  });

  it("prefers surround over stereo, per language, and keeps every unlabelled track", () => {
    const r = run(
      probe([
        video("h264", 1920, 1080, { tags: { BPS: "9000000" } }),
        audio("aac", 2, "kor", undefined, { isDefault: true }),
        audio("ac3", 6, "kor"),
        audio("aac", 2, "eng"),
        audio("aac", 2),
        audio("aac", 2),
      ]),
      "kor",
    );
    expect(actions(r.plan?.tracks ?? [])).toEqual({
      1: "drop",
      2: "keep",
      3: "keep",
      4: "keep",
      5: "keep",
    });
    expect(r.plan?.tracks.find((t) => t.index === 2)?.makeDefault).toBe(true);
  });
});
