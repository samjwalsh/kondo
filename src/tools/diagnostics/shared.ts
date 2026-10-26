export interface EncoderReport {
  ffmpeg: { found: boolean; version: string | null; error: string | null };
  encoders: { hevc_nvenc: boolean; libx265: boolean; eac3: boolean };
  gpu: { name: string; driver: string } | null;
  checkedAt: string;
}

export interface TestEncodePayload {
  slot: "gpu" | "cpu";
  seconds: number;
}

export interface TestEncodeResult {
  encoder: string;
  seconds: number;
  averageFps: number | null;
}

export interface StartTestBody {
  slot: "gpu" | "cpu";
  seconds?: number;
  /** Run now, outside the night window (still yields to Plex). */
  force?: boolean;
}
