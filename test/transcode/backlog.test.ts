import { describe, expect, it } from "vitest";
import { gpuDecision } from "../../src/tools/transcode/backlog.js";

const HOUR = 3600;

describe("GPU only for a long CPU backlog", () => {
  it("keeps the GPU out while the CPU can get through the backlog in time", () => {
    // 100 hours of video at 2x real time = 50 hours of CPU work.
    const d = gpuDecision({
      cpuInUse: true,
      backlogSeconds: 100 * HOUR,
      cpuSpeed: 2,
      thresholdHours: 72,
    });
    expect(d).toEqual({ useGpu: false, cpuHours: 50, thresholdHours: 72 });
  });

  it("brings the GPU in above the threshold", () => {
    const d = gpuDecision({
      cpuInUse: true,
      backlogSeconds: 200 * HOUR,
      cpuSpeed: 2,
      thresholdHours: 72,
    });
    expect(d.useGpu).toBe(true);
  });

  it("assumes 2x real time until the CPU's speed is known", () => {
    const d = gpuDecision({
      cpuInUse: true,
      backlogSeconds: 10 * HOUR,
      cpuSpeed: null,
      thresholdHours: 72,
    });
    expect(d.cpuHours).toBe(5);
  });

  it("always uses the GPU with threshold 0 or without the CPU", () => {
    expect(
      gpuDecision({ cpuInUse: true, backlogSeconds: 0, cpuSpeed: 2, thresholdHours: 0 }).useGpu,
    ).toBe(true);
    expect(
      gpuDecision({ cpuInUse: false, backlogSeconds: 0, cpuSpeed: null, thresholdHours: 72 }),
    ).toEqual({
      useGpu: true,
      cpuHours: null,
      thresholdHours: 72,
    });
  });
});
