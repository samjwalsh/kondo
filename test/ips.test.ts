import { describe, expect, it } from "vitest";
import { parseNeighbours, scanRange } from "../src/tools/ips/scan.js";

describe("parseNeighbours", () => {
  it("keeps entries with a MAC that didn't fail", () => {
    const arp = parseNeighbours([
      "10.0.0.5 dev eth0 lladdr aa:aa:aa:aa:aa:01 REACHABLE",
      "10.0.0.6 dev eth0 lladdr aa:aa:aa:aa:aa:02 STALE",
      "10.0.0.7 dev eth0 FAILED",
      "10.0.0.8 dev eth0 INCOMPLETE",
      "10.0.0.9 dev eth0 lladdr aa:aa:aa:aa:aa:03 router REACHABLE",
    ]);
    expect([...arp.keys()]).toEqual(["10.0.0.5", "10.0.0.6", "10.0.0.9"]);
  });
});

describe("scanRange", () => {
  it("returns the lowest address nothing answered on", async () => {
    const scan = await scanRange({
      network: { prefix: "10.0.0", self: "10.0.0.100" },
      from: 100,
      to: 106,
      reserved: ["104", "10.0.0.105"],
      probe: {
        ping: async (ip) => ip === "10.0.0.101",
        neighbours: async () => [
          "10.0.0.101 dev eth0 lladdr aa:aa:aa:aa:aa:01 REACHABLE",
          "10.0.0.102 dev eth0 lladdr aa:aa:aa:aa:aa:02 REACHABLE",
          "10.0.0.103 dev eth0 FAILED",
        ],
      },
    });
    expect(scan.taken.map((t) => [t.ip, t.by])).toEqual([
      ["10.0.0.100", "this machine"],
      ["10.0.0.101", "reply"],
      ["10.0.0.102", "arp"],
      ["10.0.0.104", "reserved"],
      ["10.0.0.105", "reserved"],
    ]);
    expect(scan.firstFree).toBe("10.0.0.103");
    expect(scan.freeCount).toBe(2);
  });
});
