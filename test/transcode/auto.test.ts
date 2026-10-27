import { afterEach, describe, expect, it } from "vitest";
import { createKondo, type Kondo } from "../../src/server/kondo.js";
import transcode from "../../src/tools/transcode/server.js";
import { LibraryStore } from "../../src/tools/transcode/store.js";
import { testConfig } from "../helpers.js";

const started: Kondo[] = [];

afterEach(async () => {
  for (const k of started.splice(0)) await k.stop();
});

async function kondoWithResults(waiting: number) {
  const k = await createKondo(testConfig(), { background: false, tools: [transcode] });
  await k.start();
  started.push(k);
  const store = new LibraryStore(k.db);
  const found = new Map(
    Array.from({ length: waiting + 1 }, (_, i) => [
      `/tv/Show/E${i}.mkv`,
      { root: "/tv", size: 1000, mtimeMs: 1 },
    ]),
  );
  store.reconcile(found, new Date().toISOString(), true);
  const ids = store.needingProbe().map((f) => f.id);
  for (const id of ids) store.saveOutcome(id, { status: "awaiting-approval", outputBytes: 100 });
  // One sent back after a failed swap: that needs a person, even in automatic mode.
  const failed = ids.at(-1) ?? 0;
  store.setOutcomeStatus(failed, "awaiting-approval", "Couldn't swap it in: disk full");
  return { k, store, ids: ids.slice(0, -1), failed };
}

describe("automatic mode", () => {
  it("approves results that passed, within the daily limit, but not ones that failed to swap", async () => {
    const { k, store, ids, failed } = await kondoWithResults(3);
    k.settings.update("transcode", { mode: "auto", maxSwapsPerDay: 2 });

    expect(ids.map((id) => store.outcome(id)?.status)).toEqual([
      "approved",
      "approved",
      "awaiting-approval",
    ]);
    expect(store.outcome(failed)?.status).toBe("awaiting-approval");
  });

  it("approves everything waiting when there's no limit", async () => {
    const { k, store, ids } = await kondoWithResults(3);
    k.settings.update("transcode", { mode: "auto", maxSwapsPerDay: 0 });
    expect(ids.every((id) => store.outcome(id)?.status === "approved")).toBe(true);
  });

  it("leaves results alone in approval mode", async () => {
    const { k, store, ids } = await kondoWithResults(2);
    k.settings.update("transcode", { mode: "approval" });
    expect(ids.every((id) => store.outcome(id)?.status === "awaiting-approval")).toBe(true);
  });
});
