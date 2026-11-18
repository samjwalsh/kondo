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
    ).join("\n");
    expect(text).toBe(
      [
        "Replaced 2 files, saved 6 GB (1.25 TB total)",
        "1 not worth it · 1 failed",
        "1,526 to go",
      ].join("\n"),
    );
  });

  it("mentions results waiting for approval, and nights with only problems", () => {
    expect(morningSummary([entry("failed")], { ...state, awaitingApproval: 3 }).join("\n")).toBe(
      ["Nothing replaced", "1 failed", "1,526 to go · 3 awaiting approval"].join("\n"),
    );
  });

  it("still checks in after a quiet night, with the reason when there's an obvious one", () => {
    expect(morningSummary([], state).join("\n")).toBe("Nothing replaced\n1,526 to go");
    expect(morningSummary([], { ...state, idleBecause: "paused" }).join("\n")).toBe(
      "Nothing replaced (paused)\n1,526 to go",
    );
  });
});
