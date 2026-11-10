// The CPU encoder (x265) makes smaller files than the GPU (NVENC) at the same quality, and
// encoding sooner frees no space while the original still seeds as a hardlinked torrent. So the
// GPU only joins in when the CPU alone would take too long to get through what's waiting.

/** Used until the CPU has swapped in a result of its own (about what it does on this host). */
export const DEFAULT_CPU_SPEED = 2;

export interface GpuDecision {
  useGpu: boolean;
  /** Hours the CPU alone would need for everything waiting; null when the CPU isn't in use. */
  cpuHours: number | null;
  thresholdHours: number;
}

export function gpuDecision(o: {
  cpuInUse: boolean;
  backlogSeconds: number;
  /** Multiple of real time; null if not measured yet. */
  cpuSpeed: number | null;
  thresholdHours: number;
}): GpuDecision {
  if (!o.cpuInUse) return { useGpu: true, cpuHours: null, thresholdHours: o.thresholdHours };
  const cpuHours = o.backlogSeconds / (o.cpuSpeed ?? DEFAULT_CPU_SPEED) / 3600;
  return {
    useGpu: o.thresholdHours <= 0 || cpuHours > o.thresholdHours,
    cpuHours,
    thresholdHours: o.thresholdHours,
  };
}
