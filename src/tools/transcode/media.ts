import { normalizeLanguage } from "./languages.js";
import type {
  AttachmentInfo,
  AudioInfo,
  Hdr,
  MediaInfo,
  SubtitleInfo,
  VideoInfo,
} from "./shared.js";

// The parts of `ffprobe -show_format -show_streams -print_format json` Kondo reads.
export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_transfer?: string;
  channels?: number;
  bit_rate?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string }[];
}

export interface Probe {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

/** What a track with no recorded bitrate is assumed to use (kb/s). */
export function assumedAudioKbps(codec: string, channels: number): number {
  const multi = channels > 2;
  switch (codec) {
    case "truehd":
      return multi ? 4000 : 1500;
    case "dts":
      return multi ? 1509 : 768;
    case "flac":
    case "alac":
      return Math.max(1, channels) * 400;
    case "eac3":
      return multi ? 640 : 224;
    case "ac3":
      return multi ? 448 : 192;
    case "opus":
      return multi ? 384 : 128;
    default:
      if (codec.startsWith("pcm_")) return Math.max(1, channels) * 768;
      return multi ? 384 : 160;
  }
}

function tag(tags: Record<string, string> | undefined, name: string): string | null {
  if (!tags) return null;
  const key = Object.keys(tags).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? tags[key] : undefined;
  return value?.trim() ? value.trim() : null;
}

/** A stream's bitrate in kb/s from the stream itself or Matroska's BPS statistics tag. */
function readKbps(stream: ProbeStream): number | null {
  const raw = stream.bit_rate ?? tag(stream.tags, "BPS") ?? tag(stream.tags, "BPS-eng");
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n / 1000 : null;
}

const flag = (s: ProbeStream, name: string) => (s.disposition?.[name] ?? 0) === 1;

function hdrOf(s: ProbeStream): Hdr {
  const dovi =
    s.side_data_list?.some((d) => d.side_data_type?.toLowerCase().includes("dovi")) ||
    ["dvh1", "dvhe", "dav1"].includes(s.codec_tag_string ?? "");
  if (dovi) return "dolby-vision";
  if (s.color_transfer === "smpte2084") return "hdr10";
  if (s.color_transfer === "arib-std-b67") return "hlg";
  return "none";
}

function bitDepthOf(s: ProbeStream): number {
  const raw = Number(s.bits_per_raw_sample);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const pix = s.pix_fmt ?? "";
  if (/12(le|be)?$/.test(pix)) return 12;
  if (/10(le|be)?$/.test(pix) || pix === "p010le") return 10;
  return 8;
}

export function extractMediaInfo(probe: Probe): MediaInfo {
  const streams = probe.streams ?? [];
  const format = probe.format ?? {};
  const durationS = Number(format.duration ?? 0) || 0;
  const sizeBytes = Number(format.size ?? 0) || 0;

  const audio: AudioInfo[] = streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => {
      const title = tag(s.tags, "title");
      return {
        index: s.index,
        codec: s.codec_name ?? "unknown",
        profile: s.profile ?? null,
        channels: s.channels ?? 2,
        language: normalizeLanguage(tag(s.tags, "language")),
        title,
        isDefault: flag(s, "default"),
        commentary: flag(s, "comment") || /comment/i.test(title ?? ""),
        descriptive:
          flag(s, "visual_impaired") ||
          /audio description|descriptive|described video/i.test(title ?? "") ||
          /\bAD\b/.test(title ?? ""),
        kbps: readKbps(s),
      };
    });

  const subtitles: SubtitleInfo[] = streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s) => {
      const title = tag(s.tags, "title");
      return {
        index: s.index,
        codec: s.codec_name ?? "unknown",
        language: normalizeLanguage(tag(s.tags, "language")),
        title,
        isDefault: flag(s, "default"),
        forced: flag(s, "forced") || /forced/i.test(title ?? ""),
        hearingImpaired: flag(s, "hearing_impaired") || /\bSDH\b|hearing/i.test(title ?? ""),
        kbps: readKbps(s),
      };
    });

  // Cover art arrives as a "video" stream with the attached_pic flag.
  const attachments: AttachmentInfo[] = streams
    .filter(
      (s) => s.codec_type === "attachment" || (s.codec_type === "video" && flag(s, "attached_pic")),
    )
    .map((s) => {
      const mimetype = tag(s.tags, "mimetype");
      const filename = tag(s.tags, "filename");
      const font =
        /font|truetype|opentype|sfnt/i.test(mimetype ?? "") ||
        /\.(ttf|otf|ttc)$/i.test(filename ?? "");
      return { index: s.index, mimetype, filename, font };
    });

  const v = streams.find((s) => s.codec_type === "video" && !flag(s, "attached_pic"));
  let video: VideoInfo | null = null;
  if (v) {
    let kbps = readKbps(v);
    let kbpsEstimated = false;
    if (kbps === null && durationS > 0) {
      const totalKbps = Number(format.bit_rate) / 1000 || (sizeBytes * 8) / durationS / 1000;
      const others =
        audio.reduce((sum, a) => sum + (a.kbps ?? assumedAudioKbps(a.codec, a.channels)), 0) +
        subtitles.reduce((sum, s) => sum + (s.kbps ?? 0), 0);
      kbps = Math.max(0, totalKbps - others);
      kbpsEstimated = true;
    }
    video = {
      index: v.index,
      codec: v.codec_name ?? "unknown",
      profile: v.profile ?? null,
      width: v.width ?? 0,
      height: v.height ?? 0,
      bitDepth: bitDepthOf(v),
      hdr: hdrOf(v),
      kbps: kbps === null ? null : Math.round(kbps),
      kbpsEstimated,
    };
  }

  return {
    container: format.format_name ?? "unknown",
    durationS,
    sizeBytes,
    video,
    audio,
    subtitles,
    attachments,
    kondoTag: tag(format.tags, "KONDO"),
  };
}
