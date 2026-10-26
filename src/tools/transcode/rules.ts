// What Kondo would do with a file: transcode or skip it, and which tracks to
// keep, convert or drop. Pure functions — the rules from DESIGN.md.
import { languageName } from "./languages.js";
import { assumedAudioKbps } from "./media.js";
import type {
  AudioInfo,
  Decision,
  MediaInfo,
  Plan,
  PlannedTrack,
  ReasonCode,
  SubtitleInfo,
} from "./shared.js";

export interface RuleSettings {
  /** Re-encode files already in H.265/AV1/VP9 only above these video bitrates (Mb/s). */
  threshold1080Mbps: number;
  threshold720Mbps: number;
  thresholdSdMbps: number;
}

export type Resolution = "above-1080p" | "1080p" | "720p" | "sd";

/** Uses the 16:9-equivalent height, so letterboxed 1920×800 still counts as 1080p. */
export function resolutionOf(width: number, height: number): Resolution {
  const effective = Math.max(height, (width * 9) / 16);
  if (effective > 1200) return "above-1080p";
  if (effective > 800) return "1080p";
  if (effective > 576) return "720p";
  return "sd";
}

/** Typical video bitrate of Squish/Kondo output (kb/s), measured on the library. */
const TARGET_VIDEO_KBPS: Record<Exclude<Resolution, "above-1080p">, number> = {
  "1080p": 1500,
  "720p": 700,
  sd: 350,
};

const EFFICIENT = new Set(["hevc", "av1", "vp9"]);
const OLD_CODECS = new Set([
  "mpeg2video",
  "mpeg1video",
  "mpeg4",
  "msmpeg4v1",
  "msmpeg4v2",
  "msmpeg4v3",
  "vc1",
  "wmv1",
  "wmv2",
  "wmv3",
  "h263",
  "vp8",
  "theora",
  "rv30",
  "rv40",
]);
const COPY_AUDIO = new Set(["aac", "ac3", "eac3", "opus", "mp3", "vorbis", "mp2"]);
const STYLED_SUBS = new Set(["ass", "ssa"]);
const CONVERT_SUBS = new Set(["mov_text", "webvtt", "text"]);
const UNSTORABLE_SUBS = new Set(["eia_608", "dvb_teletext", "arib_caption"]);

const VIDEO_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "H.265",
  av1: "AV1",
  vp9: "VP9",
  mpeg2video: "MPEG-2",
  mpeg1video: "MPEG-1",
  mpeg4: "MPEG-4 (Xvid/DivX)",
  vc1: "VC-1",
  wmv3: "WMV",
};

export function mbps(kbps: number): string {
  return `${(kbps / 1000).toFixed(1)} Mb/s`;
}

function videoName(codec: string): string {
  return VIDEO_NAMES[codec] ?? codec.toUpperCase();
}

function audioCodecName(a: AudioInfo): string {
  const atmos = /atmos/i.test(`${a.profile ?? ""} ${a.title ?? ""}`) ? " Atmos" : "";
  switch (a.codec) {
    case "dts":
      if (a.profile?.includes("MA")) return "DTS-HD MA";
      if (a.profile?.includes("HRA")) return "DTS-HD HRA";
      return "DTS";
    case "truehd":
      return `TrueHD${atmos}`;
    case "eac3":
      return `E-AC3${atmos}`;
    case "ac3":
      return "AC3";
    case "aac":
      return "AAC";
    case "flac":
      return "FLAC";
    case "opus":
      return "Opus";
    case "mp3":
      return "MP3";
    default:
      return a.codec.startsWith("pcm_") ? "PCM" : a.codec.toUpperCase();
  }
}

function channelsName(channels: number): string {
  return (
    ({ 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" } as Record<number, string>)[channels] ??
    `${channels}ch`
  );
}

const SUB_NAMES: Record<string, string> = {
  subrip: "SRT",
  ass: "ASS",
  ssa: "SSA",
  hdmv_pgs_subtitle: "PGS (image)",
  dvd_subtitle: "VobSub (image)",
  dvb_subtitle: "DVB (image)",
  mov_text: "MP4 text",
  webvtt: "WebVTT",
};

const quoted = (title: string | null) => (title ? ` · “${title}”` : "");

function describeAudio(a: AudioInfo): string {
  return `${languageName(a.language)} · ${audioCodecName(a)} ${channelsName(a.channels)}${quoted(a.title)}`;
}

function describeSubtitle(s: SubtitleInfo): string {
  const flags = [s.forced ? "forced" : "", s.hearingImpaired ? "SDH" : ""]
    .filter(Boolean)
    .join(", ");
  return `${languageName(s.language)} · ${SUB_NAMES[s.codec] ?? s.codec}${flags ? ` (${flags})` : ""}${quoted(s.title)}`;
}

/** How good a source an audio track is: lossless beats lossy, then the bigger lossy formats. */
function audioQuality(a: AudioInfo): number {
  if (["truehd", "flac", "alac", "mlp"].includes(a.codec) || a.codec.startsWith("pcm_")) return 5;
  if (a.codec === "dts") return a.profile?.includes("MA") ? 5 : a.profile?.includes("HRA") ? 4 : 3;
  if (a.codec === "eac3") return 3;
  if (a.codec === "ac3" || a.codec === "opus") return 2;
  if (a.codec === "aac") return 1;
  return 0;
}

/** Positive when `a` is the better track to keep: more channels, then a better source. */
function compareAudio(a: AudioInfo, b: AudioInfo): number {
  return (
    Math.min(a.channels, 6) - Math.min(b.channels, 6) ||
    audioQuality(a) - audioQuality(b) ||
    (a.kbps ?? 0) - (b.kbps ?? 0) ||
    Number(a.isDefault) - Number(b.isDefault) ||
    b.index - a.index
  );
}

interface AudioOutput {
  to: string | null;
  kbps: number;
  reason: string | null;
}

/** Copy small lossy formats; convert everything else to E-AC3. */
function audioOutput(a: AudioInfo): AudioOutput {
  if (COPY_AUDIO.has(a.codec))
    return { to: null, kbps: a.kbps ?? assumedAudioKbps(a.codec, a.channels), reason: null };
  const lossless =
    a.codec === "truehd" ||
    a.codec === "flac" ||
    a.codec === "alac" ||
    a.codec.startsWith("pcm_") ||
    (a.codec === "dts" && a.profile?.includes("MA"));
  const reason = lossless
    ? "Lossless audio is very large"
    : a.codec === "dts"
      ? "DTS is large"
      : "Not a format Kondo keeps as-is";
  if (a.channels > 2) {
    const downmix = a.channels > 6 ? ` (from ${channelsName(a.channels)})` : "";
    return { to: `E-AC3 5.1${downmix} · 640 kb/s`, kbps: 640, reason };
  }
  if (a.channels === 1) return { to: "E-AC3 mono · 128 kb/s", kbps: 128, reason };
  return { to: "E-AC3 stereo · 224 kb/s", kbps: 224, reason };
}

export function planTracks(info: MediaInfo, originalLanguage: string | null): Plan {
  const tracks: PlannedTrack[] = [];
  const notes: string[] = [];
  const original = originalLanguage && originalLanguage !== "eng" ? originalLanguage : null;
  const video = info.video;
  const resolution = video ? resolutionOf(video.width, video.height) : "1080p";
  const targetVideoKbps =
    resolution === "above-1080p" ? (video?.kbps ?? 0) : TARGET_VIDEO_KBPS[resolution];

  // Audio --------------------------------------------------------------------
  const usable = info.audio.filter((a) => !a.commentary && !a.descriptive);
  const wanted = usable.filter(
    (a) => a.language === "eng" || a.language === null || a.language === original,
  );
  // One track per known language, the best one (unlabelled tracks are all kept).
  const bestByLanguage = new Map<string, AudioInfo>();
  for (const a of wanted) {
    if (a.language === null) continue;
    const current = bestByLanguage.get(a.language);
    if (!current || compareAudio(a, current) > 0) bestByLanguage.set(a.language, a);
  }
  const duplicates = new Set(
    wanted.filter((a) => a.language !== null && bestByLanguage.get(a.language) !== a),
  );
  let keep = wanted.filter((a) => !duplicates.has(a));
  let fallback = false;
  if (keep.length === 0) {
    const main =
      usable.find((a) => a.isDefault) ??
      usable[0] ??
      info.audio.find((a) => a.isDefault) ??
      info.audio[0];
    keep = main ? [main] : [];
    fallback = true;
  }
  const defaultAudio =
    keep.find((a) => original && a.language === original) ??
    keep.find((a) => a.language === "eng") ??
    keep[0];

  // A lone unlabelled track in a title whose original language is known is almost
  // certainly in that language: label it, so players show and pick it properly.
  const unlabelledKept = keep.filter((a) => a.language === null);
  const labelAs =
    originalLanguage &&
    unlabelledKept.length === 1 &&
    !keep.some((a) => a.language === originalLanguage)
      ? originalLanguage
      : null;

  let audioKbps = 0;
  for (const a of info.audio) {
    const summary = describeAudio(a);
    if (keep.includes(a)) {
      const out = audioOutput(a);
      audioKbps += out.kbps;
      const setLanguage =
        a.language === null && labelAs
          ? labelAs
          : a.languageFromTitle
            ? (a.language ?? undefined)
            : undefined;
      let why: string;
      if (fallback) {
        why =
          a.descriptive || a.commentary
            ? `The only audio track (marked as ${a.commentary ? "commentary" : "audio description"}), so it's kept`
            : "No English or original-language audio, so keeping the main track";
      } else if (a.language === null) {
        why = setLanguage
          ? `Not labelled; the original language is ${languageName(setLanguage)}, so it's labelled that`
          : "Language not labelled, kept to be safe";
      } else {
        why = a.language === "eng" ? "English" : `Original language (${languageName(a.language)})`;
        if (a.languageFromTitle) why += ", going by its title";
      }
      tracks.push({
        index: a.index,
        kind: "audio",
        summary,
        action: out.to ? "convert" : "keep",
        to: out.to ?? undefined,
        reason: out.reason ? `${why}. ${out.reason}` : why,
        makeDefault: a === defaultAudio,
        setLanguage,
      });
      if (out.to && /atmos/i.test(summary))
        notes.push(`Atmos is lost converting ${audioCodecName(a)} to E-AC3.`);
    } else {
      const better = a.language === null ? undefined : bestByLanguage.get(a.language);
      const reason =
        duplicates.has(a) && better
          ? `Another ${languageName(a.language)} track is kept (${audioCodecName(better)} ${channelsName(better.channels)})`
          : a.commentary
            ? "Commentary"
            : a.descriptive
              ? "Audio description"
              : `${languageName(a.language)}, not English${original ? ` or ${languageName(original)}` : ""}`;
      tracks.push({ index: a.index, kind: "audio", summary, action: "drop", reason });
    }
  }
  const sourceDefault = info.audio.find((a) => a.isDefault);
  if (defaultAudio && sourceDefault && defaultAudio !== sourceDefault) {
    notes.push(`Default audio changes to: ${describeAudio(defaultAudio)}.`);
  }

  // Subtitles ------------------------------------------------------------------
  let subtitleKbps = 0;
  const keptSubs: SubtitleInfo[] = [];
  for (const s of info.subtitles) {
    const summary = describeSubtitle(s);
    if (UNSTORABLE_SUBS.has(s.codec)) {
      tracks.push({
        index: s.index,
        kind: "subtitle",
        summary,
        action: "drop",
        reason: "Can't be stored in MKV",
      });
      continue;
    }
    const why =
      s.language === "eng"
        ? `English${s.languageFromTitle ? ", going by its title" : ""}`
        : s.language === null
          ? "Language not labelled, kept to be safe"
          : null;
    if (!why) {
      tracks.push({
        index: s.index,
        kind: "subtitle",
        summary,
        action: "drop",
        reason: `${languageName(s.language)}${s.forced ? " forced subtitles (for its own speakers)" : ""}, not English`,
      });
      continue;
    }
    keptSubs.push(s);
    subtitleKbps += s.kbps ?? 0;
    const convert = CONVERT_SUBS.has(s.codec);
    tracks.push({
      index: s.index,
      kind: "subtitle",
      summary,
      action: convert ? "convert" : "keep",
      to: convert ? "SRT" : undefined,
      reason: convert ? `${why}. MKV can't hold this format` : why,
      setLanguage: s.languageFromTitle ? (s.language ?? undefined) : undefined,
    });
  }

  // Attachments --------------------------------------------------------------
  const styled = keptSubs.some((s) => STYLED_SUBS.has(s.codec));
  for (const at of info.attachments) {
    const summary = at.filename ?? at.mimetype ?? "Attachment";
    if (at.font && styled) {
      tracks.push({
        index: at.index,
        kind: "attachment",
        summary,
        action: "keep",
        reason: "Font for the styled subtitles",
      });
    } else {
      tracks.push({
        index: at.index,
        kind: "attachment",
        summary,
        action: "drop",
        reason: at.font ? "No styled subtitles kept" : "Cover image, not needed",
      });
    }
  }

  const englishAudio = keep.some(
    (a) =>
      a.language === "eng" ||
      (a.language === null &&
        (labelAs === "eng" || originalLanguage === "eng" || originalLanguage === null)),
  );
  const englishSubs = keptSubs.some((s) => s.language === "eng" || s.language === null);
  if (!englishAudio && !englishSubs) {
    notes.push(
      "No English audio or subtitles inside the file (Bazarr may add an .srt next to it).",
    );
  }

  const estimatedBytes = Math.round(
    (((targetVideoKbps + audioKbps + subtitleKbps) * 1000) / 8) * info.durationS * 1.01,
  );

  return {
    video: {
      from: video
        ? `${videoName(video.codec)} ${video.width}×${video.height}${video.bitDepth > 8 ? ` ${video.bitDepth}-bit` : ""}${video.kbps !== null ? ` · ${mbps(video.kbps)}${video.kbpsEstimated ? " (estimated)" : ""}` : ""}`
        : "No video",
      to: `H.265 ${video && video.bitDepth > 8 ? "10-bit" : "8-bit"} · ≈${mbps(targetVideoKbps)}`,
    },
    tracks,
    notes,
    estimatedBytes,
  };
}

export interface Evaluation {
  decision: Decision;
  reasonCode: ReasonCode;
  reason: string;
  plan: Plan | null;
}

/** The decision for one file. `info` is null when the file couldn't be read. */
export function evaluate(
  info: MediaInfo | null,
  originalLanguage: string | null,
  settings: RuleSettings,
): Evaluation {
  if (!info)
    return {
      decision: "error",
      reasonCode: "probe-failed",
      reason: "Couldn't read the file",
      plan: null,
    };
  const video = info.video;
  if (!video)
    return { decision: "skip", reasonCode: "no-video", reason: "No video stream", plan: null };
  if (info.kondoTag) {
    return {
      decision: "skip",
      reasonCode: "kondo-done",
      reason: `Already done by Kondo (${info.kondoTag})`,
      plan: null,
    };
  }
  const resolution = resolutionOf(video.width, video.height);
  if (resolution === "above-1080p") {
    return {
      decision: "skip",
      reasonCode: "above-1080p",
      reason: `${video.width}×${video.height} is above 1080p`,
      plan: null,
    };
  }
  if (video.hdr !== "none") {
    const name = { hdr10: "HDR10", hlg: "HLG", "dolby-vision": "Dolby Vision" }[video.hdr];
    return { decision: "skip", reasonCode: "hdr", reason: `${name} isn't handled yet`, plan: null };
  }

  let reasonCode: ReasonCode;
  let reason: string;
  if (EFFICIENT.has(video.codec)) {
    const threshold =
      (resolution === "1080p"
        ? settings.threshold1080Mbps
        : resolution === "720p"
          ? settings.threshold720Mbps
          : settings.thresholdSdMbps) * 1000;
    if (video.kbps === null) {
      return {
        decision: "skip",
        reasonCode: "already-efficient",
        reason: `Already ${videoName(video.codec)} (bitrate unknown)`,
        plan: null,
      };
    }
    if (video.kbps <= threshold) {
      return {
        decision: "skip",
        reasonCode: "already-efficient",
        reason: `Already ${videoName(video.codec)} at ${mbps(video.kbps)} (re-encodes above ${mbps(threshold)})`,
        plan: null,
      };
    }
    reasonCode = "h265-high-bitrate";
    reason = `${videoName(video.codec)} at ${mbps(video.kbps)}, above the ${mbps(threshold)} threshold`;
  } else if (video.codec === "h264") {
    reasonCode = "h264";
    reason = `H.264${video.kbps !== null ? ` at ${mbps(video.kbps)}` : ""} → H.265`;
  } else if (OLD_CODECS.has(video.codec)) {
    reasonCode = "old-codec";
    reason = `${videoName(video.codec)} → H.265`;
  } else {
    return {
      decision: "skip",
      reasonCode: "unknown-codec",
      reason: `Video codec “${video.codec}” isn't one Kondo handles`,
      plan: null,
    };
  }

  const plan = planTracks(info, originalLanguage);
  const size = info.sizeBytes;
  if (size > 0 && plan.estimatedBytes > size * 0.9) {
    const pct = Math.max(0, Math.round((1 - plan.estimatedBytes / size) * 100));
    return {
      decision: "skip",
      reasonCode: "small-saving",
      reason: `Expected to shrink only about ${pct}%`,
      plan,
    };
  }
  return { decision: "transcode", reasonCode, reason, plan };
}
