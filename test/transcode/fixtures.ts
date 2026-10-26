// Small builders for ffprobe-shaped JSON, modelled on real files from the library
// (names and titles anonymised).
import type { Probe, ProbeStream } from "../../src/tools/transcode/media.js";

let next = 0;

export function probe(streams: Omit<ProbeStream, "index">[], format: Probe["format"] = {}): Probe {
  next = 0;
  return {
    streams: streams.map((s) => ({ index: next++, ...s })),
    format: { format_name: "matroska,webm", duration: "2600", size: "8000000000", ...format },
  };
}

type Extra = Partial<Omit<ProbeStream, "index">>;
const tags = (language?: string, title?: string, extra: Record<string, string> = {}) => ({
  ...(language ? { language } : {}),
  ...(title ? { title } : {}),
  ...extra,
});

export const video = (codec: string, width: number, height: number, extra: Extra = {}) => ({
  codec_type: "video",
  codec_name: codec,
  width,
  height,
  pix_fmt: "yuv420p",
  disposition: { default: 1 },
  ...extra,
});

export const audio = (
  codec: string,
  channels: number,
  language?: string,
  title?: string,
  extra: Extra & { isDefault?: boolean; bps?: number } = {},
) => {
  const { isDefault, bps, ...rest } = extra;
  return {
    codec_type: "audio",
    codec_name: codec,
    channels,
    disposition: { default: isDefault ? 1 : 0 },
    tags: tags(language, title, bps ? { BPS: String(bps) } : {}),
    ...rest,
  };
};

export const subtitle = (
  codec: string,
  language?: string,
  title?: string,
  extra: Extra & { forced?: boolean } = {},
) => {
  const { forced, ...rest } = extra;
  return {
    codec_type: "subtitle",
    codec_name: codec,
    disposition: { default: 0, forced: forced ? 1 : 0 },
    tags: tags(language, title),
    ...rest,
  };
};

export const attachment = (filename: string, mimetype: string) => ({
  codec_type: "attachment",
  codec_name: "ttf",
  tags: { filename, mimetype },
});
