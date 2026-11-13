// What Kondo would do with a file: transcode or skip it, and which tracks to
// keep, convert or drop. Pure functions — the rules from DESIGN.md.
import { languageName } from "./languages.js";
import { assumedAudioKbps } from "./media.js";
import type {
  AudioInfo,
  Decision,
  MediaInfo,
  Outcome,
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
/** Formats nearly every Plex player plays directly, so they're copied when stereo or mono. */
const COPY_AUDIO = new Set(["aac", "mp3"]);
/** Every kept audio track ends up as AAC stereo (or mono) at these rates (ffmpeg's own encoder). */
export const AAC_STEREO_KBPS = 192;
export const AAC_MONO_KBPS = 96;
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

/** Stereo first (a real stereo mix beats a downmix of surround), then surround, then mono. */
function channelRank(channels: number): number {
  return channels === 2 ? 3 : channels > 2 ? 2 : 1;
}

/** Positive when `a` is the better track to keep: a stereo mix, then a better source. */
function compareAudio(a: AudioInfo, b: AudioInfo): number {
  return (
    channelRank(a.channels) - channelRank(b.channels) ||
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
  /** Output channels when converting. */
  channels: 1 | 2;
}

/** What the encoder does with a kept audio track: copy it, or AAC at these settings. */
export function audioTarget(
  a: AudioInfo,
): { copy: true } | { copy: false; channels: 1 | 2; kbps: number } {
  const out = audioOutput(a);
  return out.to === null ? { copy: true } : { copy: false, channels: out.channels, kbps: out.kbps };
}

/** Subtitle formats Matroska can't hold, converted to SRT. */
export function subtitleNeedsSrt(codec: string): boolean {
  return CONVERT_SUBS.has(codec);
}

/**
 * Stereo (or mono) AAC and MP3 are copied; everything else becomes AAC, surround downmixed to
 * stereo. AAC stereo direct-plays on nearly every Plex player (browsers can't play AC3/E-AC3/DTS,
 * and many players take at most 6 channels), so Plex doesn't have to convert the audio.
 */
function audioOutput(a: AudioInfo): AudioOutput {
  if (COPY_AUDIO.has(a.codec) && a.channels <= 2)
    return {
      to: null,
      kbps: a.kbps ?? assumedAudioKbps(a.codec, a.channels),
      reason: null,
      channels: 2,
    };
  const reason =
    a.channels > 2
      ? `${channelsName(a.channels)} isn't playable everywhere, so it's downmixed to stereo AAC`
      : `${audioCodecName(a)} isn't playable everywhere`;
  if (a.channels === 1)
    return { to: `AAC mono · ${AAC_MONO_KBPS} kb/s`, kbps: AAC_MONO_KBPS, reason, channels: 1 };
  return { to: `AAC stereo · ${AAC_STEREO_KBPS} kb/s`, kbps: AAC_STEREO_KBPS, reason, channels: 2 };
}

/** True when a kept track would be converted (it isn't stereo/mono AAC or MP3). */
export function audioNeedsConverting(a: AudioInfo): boolean {
  return audioOutput(a).to !== null;
}

export interface PlanOptions {
  /** Tracks only: the video is copied as it is (audio is still converted where needed). */
  remux?: boolean;
  /** Keep every language's audio (when the original language isn't known). */
  keepAllLanguages?: boolean;
}

export function planTracks(
  info: MediaInfo,
  originalLanguage: string | null,
  options: PlanOptions = {},
): Plan {
  const remux = options.remux === true;
  const audioOut = audioOutput;
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
    (a) =>
      options.keepAllLanguages ||
      a.language === "eng" ||
      a.language === null ||
      a.language === original,
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
      const out = audioOut(a);
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
        notes.push(`Atmos is lost converting ${audioCodecName(a)} to stereo AAC.`);
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

  const estimatedBytes = remux
    ? remuxedBytes(info, tracks)
    : Math.round(
        (((targetVideoKbps + audioKbps + subtitleKbps) * 1000) / 8) * info.durationS * 1.01,
      );
  const videoFrom = video
    ? `${videoName(video.codec)} ${video.width}×${video.height}${video.bitDepth > 8 ? ` ${video.bitDepth}-bit` : ""}${video.kbps !== null ? ` · ${mbps(video.kbps)}${video.kbpsEstimated ? " (estimated)" : ""}` : ""}`
    : "No video";
  if (remux)
    return { video: { from: videoFrom, to: "Copied as it is" }, tracks, notes, estimatedBytes };

  return {
    video: {
      from: videoFrom,
      to: `H.265 ${video && video.bitDepth > 8 ? "10-bit" : "8-bit"} · ≈${mbps(targetVideoKbps)}`,
    },
    tracks,
    notes,
    estimatedBytes,
  };
}

/**
 * The file's size less the tracks a remux drops or shrinks (only their bitrate is known, not
 * their bytes).
 */
function remuxedBytes(info: MediaInfo, tracks: PlannedTrack[]): number {
  let droppedKbps = 0;
  for (const t of tracks) {
    if (t.kind === "audio" && t.action !== "keep") {
      const a = info.audio.find((x) => x.index === t.index);
      if (!a) continue;
      const before = a.kbps ?? assumedAudioKbps(a.codec, a.channels);
      droppedKbps += t.action === "drop" ? before : before - audioOutput(a).kbps;
    } else if (t.action !== "drop") {
    } else if (t.kind === "subtitle") {
      droppedKbps += info.subtitles.find((x) => x.index === t.index)?.kbps ?? 0;
    }
  }
  return Math.max(0, Math.round(info.sizeBytes - ((droppedKbps * 1000) / 8) * info.durationS));
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

/** A remembered encode result that changes the decision (so the file isn't tried again). */
export function outcomeOverride(
  outcome: Pick<Outcome, "status" | "error" | "attempts"> | null,
): Evaluation | null {
  if (!outcome) return null;
  if (outcome.status === "not-worth-it") {
    return {
      decision: "skip",
      reasonCode: "not-worth-it",
      reason: outcome.error ?? "Tried, but the result wasn't small enough",
      plan: null,
    };
  }
  if (outcome.status === "rejected") {
    return {
      decision: "skip",
      reasonCode: "rejected",
      reason: outcome.error ?? "You rejected the result",
      plan: null,
    };
  }
  if (outcome.status === "squish") {
    return {
      decision: "skip",
      reasonCode: "squish-done",
      reason: "Already encoded by Squish; encoding it again would only lose quality",
      plan: null,
    };
  }
  if (outcome.status === "failed" && outcome.attempts >= 2) {
    return {
      decision: "error",
      reasonCode: "encode-failed",
      reason: `Encoding failed twice: ${outcome.error ?? "unknown error"}`,
      plan: null,
    };
  }
  return null;
}

/**
 * Squish marked its output `… [SQUISH].mkv`. Only an H.265 file with that name counts as done:
 * Squish also renamed a few files it never encoded.
 */
export function squishOverride(file: string, info: MediaInfo | null): Evaluation | null {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (!name.includes(" [SQUISH]") || info?.video?.codec !== "hevc") return null;
  return outcomeOverride({ status: "squish", error: null, attempts: 0 });
}

/** Skipped files whose tracks may still need tidying: their video stays as it is. */
const REMUXABLE = new Set<ReasonCode>([
  "already-efficient",
  "small-saving",
  "squish-done",
  "not-worth-it",
  "kondo-done",
]);

/**
 * A file Kondo won't re-encode, but whose tracks still need work: other-language audio the track
 * rules drop (often the default one, so Plex plays the dub), or audio that isn't stereo AAC (so
 * many players can't play it directly). It's copied with only those tracks changed. Other-language
 * tracks are only dropped when the original language is known from Sonarr/Radarr, and only when
 * an English or original-language track stays; a file with nothing but a dub keeps it.
 */
export function remuxOverride(
  evaluation: Evaluation,
  info: MediaInfo | null,
  originalLanguage: string | null,
): Evaluation | null {
  if (evaluation.decision !== "skip" || !REMUXABLE.has(evaluation.reasonCode)) return null;
  const video = info?.video;
  if (!info || !video) return null;
  // Copying HDR/Dolby Vision video with this ffmpeg may lose its metadata.
  if (video.hdr !== "none" || resolutionOf(video.width, video.height) === "above-1080p")
    return null;
  const usable = info.audio.filter((a) => !a.commentary && !a.descriptive);
  const wanted = (a: AudioInfo) =>
    a.language === null || a.language === "eng" || a.language === originalLanguage;
  const foreign = originalLanguage && usable.some(wanted) ? usable.filter((a) => !wanted(a)) : [];

  const plan = planTracks(info, originalLanguage, {
    remux: true,
    keepAllLanguages: foreign.length === 0,
  });
  const converting = plan.tracks.filter((t) => t.kind === "audio" && t.action === "convert");
  // A default track players can't play that the plan replaces with one they can.
  const sourceDefault = info.audio.find((a) => a.isDefault) ?? info.audio[0];
  const newDefault = plan.tracks.find((t) => t.kind === "audio" && t.makeDefault);
  const replacedDefault =
    sourceDefault &&
    newDefault &&
    newDefault.index !== sourceDefault.index &&
    audioNeedsConverting(sourceDefault)
      ? sourceDefault
      : null;
  if (foreign.length === 0 && converting.length === 0 && !replacedDefault) return null;

  const list = (xs: string[]) =>
    xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? "");
  if (foreign.length === 0 && converting.length === 0 && replacedDefault) {
    return {
      decision: "remux",
      reasonCode: "audio-compat",
      reason: `${audioCodecName(replacedDefault)} ${channelsName(replacedDefault.channels)} default audio dropped; the stereo track becomes the default`,
      plan,
    };
  }
  if (foreign.length === 0) {
    const from = [
      ...new Set(
        info.audio
          .filter((a) => converting.some((t) => t.index === a.index))
          .map((a) => `${audioCodecName(a)} ${channelsName(a.channels)}`),
      ),
    ];
    return {
      decision: "remux",
      reasonCode: "audio-compat",
      reason: `${list(from)} audio → stereo AAC`,
      plan,
    };
  }
  const names = [...new Set(foreign.map((a) => languageName(a.language)))];
  const kept = [...new Set(usable.filter(wanted).map((a) => languageName(a.language)))];
  const defaultNote = sourceDefault && foreign.includes(sourceDefault) ? " (it's the default)" : "";
  return {
    decision: "remux",
    reasonCode: "foreign-audio",
    reason: `${list(names)} audio${defaultNote} to remove; ${list(kept)} kept${converting.length > 0 ? "; audio → stereo AAC" : ""}`,
    plan,
  };
}
