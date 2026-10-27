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

describe("feeding the encoders", () => {
  async function kondoWithCandidates(sizes: number[]) {
    const k = await createKondo(testConfig(), { background: false, tools: [transcode] });
    await k.start();
    started.push(k);
    const store = new LibraryStore(k.db);
    store.reconcile(
      new Map(sizes.map((size, i) => [`/tv/Show/E${i}.mkv`, { root: "/tv", size, mtimeMs: 1 }])),
      new Date().toISOString(),
      true,
    );
    k.db.prepare("UPDATE transcode_files SET decision = 'transcode', est_bytes = size / 5").run();
    const queued = () =>
      k.db
        .prepare("SELECT slot, payload FROM jobs WHERE type = 'encode' ORDER BY id")
        .all()
        .map((r) => [String(r.slot), JSON.parse(String(r.payload)).name]);
    return { k, queued };
  }

  it("leaves the CPU unused until it's calibrated, one file queued per encoder", async () => {
    const { k, queued } = await kondoWithCandidates([3000, 1000, 2000]);
    k.settings.update("transcode", { mode: "approval" });
    expect(queued()).toEqual([["gpu", "E0.mkv"]]);
  });

  it("offers the CPU the biggest saving, then the GPU the next", async () => {
    const { k, queued } = await kondoWithCandidates([3000, 1000, 2000]);
    k.settings.update("encoding", { cpuCrf: 27 });
    k.settings.update("transcode", { mode: "approval" });
    expect(queued()).toEqual([
      ["cpu", "E0.mkv"],
      ["gpu", "E2.mkv"],
    ]);
  });
});
