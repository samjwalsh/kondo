import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/tools/transcode/shared.js";
import { morningSummary } from "../../src/tools/transcode/summary.js";

let id = 0;
const entry = (kind: LogEntry["kind"], source = 4e9, output = 1e9): LogEntry => ({
  id: ++id,
  at: "2026-10-28T05:00:00Z",
  fileId: id,
  path: `/tv/Show/E${id}.mkv`,
  kind,
  sourceBytes: source,
  outputBytes: kind === "replaced" ? output : null,
  encoder: "hevc_nvenc",
  detail: null,
  details: null,
});

const state = { savedSoFar: 1.25e12, toTranscode: 1526, awaitingApproval: 0 };

describe("morning summary", () => {
  it("is a few short lines", () => {
    const text = morningSummary(
      [entry("replaced"), entry("replaced"), entry("not-worth-it"), entry("failed")],
      state,
    );
    expect(text).toBe(
      [
        "Kondo replaced 2 files, saving 6 GB (1.25 TB so far).",
        "1 not worth it · 1 failed. Details on the Transcode page.",
        "1,526 left to transcode.",
      ].join("\n"),
    );
  });

  it("mentions results waiting for approval, and nights with only problems", () => {
    expect(morningSummary([entry("failed")], { ...state, awaitingApproval: 3 })).toBe(
      [
        "Kondo didn't replace anything.",
        "1 failed. Details on the Transcode page.",
        "1,526 left to transcode · 3 waiting for your approval.",
      ].join("\n"),
    );
  });

  it("says nothing after a night with nothing to report", () => {
    expect(morningSummary([], state)).toBeNull();
  });
});
