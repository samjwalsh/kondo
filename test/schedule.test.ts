import { describe, expect, it } from "vitest";
import {
  clockIn,
  decideSlot,
  isInWindow,
  parseClock,
  type SlotInputs,
} from "../src/server/core/schedule.js";

describe("clock and window", () => {
  it("reads the local time in a zone, including summer time", () => {
    // 01:30 UTC is 02:30 in Dublin in July (IST) and 01:30 in January (GMT).
    expect(clockIn(new Date("2026-07-01T01:30:00Z"), "Europe/Dublin").label).toBe("02:30");
    expect(clockIn(new Date("2026-01-15T01:30:00Z"), "Europe/Dublin").label).toBe("01:30");
  });

  it("handles windows within a day and across midnight", () => {
    const [two, eight] = [parseClock("02:00"), parseClock("08:00")];
    expect(isInWindow(parseClock("01:59"), two, eight)).toBe(false);
    expect(isInWindow(parseClock("02:00"), two, eight)).toBe(true);
    expect(isInWindow(parseClock("07:59"), two, eight)).toBe(true);
    expect(isInWindow(parseClock("08:00"), two, eight)).toBe(false);
    const [ten, six] = [parseClock("22:00"), parseClock("06:00")];
    expect(isInWindow(parseClock("23:30"), ten, six)).toBe(true);
    expect(isInWindow(parseClock("05:00"), ten, six)).toBe(true);
    expect(isInWindow(parseClock("12:00"), ten, six)).toBe(false);
    expect(isInWindow(parseClock("03:00"), two, two)).toBe(false);
  });
});

function inputs(
  overrides: Partial<SlotInputs> = {},
  plex: Partial<SlotInputs["plex"]> = {},
): SlotInputs {
  return {
    enabled: true,
    force: false,
    inWindow: true,
    window: "02:00–08:00",
    idleMode: false,
    idleQuietMinutes: 15,
    ...overrides,
    plex: {
      configured: true,
      reachable: true,
      sessions: 0,
      gpuTranscoding: false,
      cpuTranscoding: false,
      quietForMs: 0,
      ...plex,
    },
  };
}

describe("slot decisions", () => {
  it("never runs while Plex is unknown", () => {
    expect(decideSlot("gpu", inputs({}, { configured: false })).allowed).toBe(false);
    expect(decideSlot("gpu", inputs({}, { reachable: false })).allowed).toBe(false);
    expect(decideSlot("cpu", inputs({ force: true }, { reachable: false })).allowed).toBe(false);
  });

  it("runs in the window, yielding only to Plex transcodes on the same hardware", () => {
    expect(decideSlot("gpu", inputs({}, { sessions: 2 })).allowed).toBe(true);
    expect(decideSlot("gpu", inputs({}, { sessions: 1, gpuTranscoding: true })).allowed).toBe(
      false,
    );
    expect(decideSlot("cpu", inputs({}, { sessions: 1, gpuTranscoding: true })).allowed).toBe(true);
    expect(decideSlot("cpu", inputs({}, { sessions: 1, cpuTranscoding: true })).allowed).toBe(
      false,
    );
  });

  it("stays off outside the window unless idle mode is on", () => {
    const d = decideSlot("gpu", inputs({ inWindow: false }));
    expect(d).toEqual({ allowed: false, reason: "Outside the night window (02:00–08:00)" });
  });

  it("in idle mode, waits for the quiet period and stops for any viewer", () => {
    const idle = { inWindow: false, idleMode: true };
    expect(decideSlot("gpu", inputs(idle, { quietForMs: 14 * 60_000 })).reason).toMatch(
      /starting in 1 min/,
    );
    expect(decideSlot("gpu", inputs(idle, { quietForMs: 15 * 60_000 })).allowed).toBe(true);
    expect(decideSlot("cpu", inputs(idle, { sessions: 1, quietForMs: 0 })).allowed).toBe(false);
  });

  it("lets a job started by hand run outside the window", () => {
    expect(decideSlot("cpu", inputs({ inWindow: false, force: true })).allowed).toBe(true);
  });

  it("respects a slot turned off in settings", () => {
    expect(decideSlot("gpu", inputs({ enabled: false, force: true })).allowed).toBe(false);
  });
});
