// The transcode lines of the morning Telegram summary.

import type { LogEntry } from "./shared.js";

function size(bytes: number): string {
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(2)} TB` : `${Math.round(bytes / 1e9)} GB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The transcode lines of the morning summary; also there after a quiet night. */
export function morningSummary(
  entries: LogEntry[],
  state: {
    savedSoFar: number;
    toTranscode: number;
    awaitingApproval: number;
    /** Why nothing would have been encoded, if there's an obvious reason. */
    idleBecause?: string | null;
  },
): string[] {
  const count = (kind: LogEntry["kind"]) => entries.filter((e) => e.kind === kind).length;
  const replaced = entries.filter((e) => e.kind === "replaced");
  const saved = replaced.reduce((sum, e) => sum + (e.sourceBytes ?? 0) - (e.outputBytes ?? 0), 0);

  const lines = [
    replaced.length > 0
      ? `Replaced ${plural(replaced.length, "file")}, saved ${size(saved)} (${size(state.savedSoFar)} total)`
      : `Nothing replaced${entries.length === 0 && state.idleBecause ? ` (${state.idleBecause})` : ""}`,
  ];
  const others = [
    [count("not-worth-it"), "not worth it"],
    [count("failed"), "failed"],
    [count("swap-failed"), "couldn't be swapped in"],
    [count("rejected"), "rejected"],
  ]
    .filter(([n]) => Number(n) > 0)
    .map(([n, label]) => `${n} ${label}`);
  if (others.length > 0) lines.push(others.join(" · "));
  const left = [`${state.toTranscode.toLocaleString("en-GB")} to go`];
  if (state.awaitingApproval > 0) left.push(`${state.awaitingApproval} awaiting approval`);
  lines.push(left.join(" · "));
  return lines;
}
