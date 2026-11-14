import { describe, expect, it } from "vitest";
import { containerIps } from "../src/server/integrations/unraid.js";
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

describe("containerIps", () => {
  it("takes the given and the fixed address, whatever the case", () => {
    expect(
      containerIps({
        Networks: {
          br0: { IPAMConfig: { IPv4Address: "10.0.0.7" }, IPAddress: "" },
          bridge: { ipAddress: "172.17.0.2" },
        },
      }).sort(),
    ).toEqual(["10.0.0.7", "172.17.0.2"]);
    expect(containerIps(null)).toEqual([]);
  });
});

describe("scanRange", () => {
  it("sorts addresses into free, stopped and taken", async () => {
    const scan = await scanRange({
      network: { prefix: "10.0.0", self: "10.0.0.100" },
      from: 100,
      to: 108,
      reserved: ["104"],
      containers: [
        { name: "sonarr", running: true, ips: ["10.0.0.105"] },
        { name: "backrest", running: false, ips: ["10.0.0.106"] },
        { name: "old", running: false, ips: ["10.0.0.101"] },
        { name: "tautulli", running: false, ips: ["10.0.0.105"] },
      ],
      probe: {
        ping: async (ip) => ip === "10.0.0.101",
        neighbours: async () => [
          "10.0.0.102 dev eth0 lladdr aa:aa:aa:aa:aa:02 REACHABLE",
          "10.0.0.103 dev eth0 FAILED",
        ],
        name: async (ip) => (ip === "10.0.0.102" ? "printer" : null),
      },
    });
    expect(scan.addresses.map((a) => [a.last, a.state, a.label, a.clash])).toEqual([
      [100, "taken", "Kondo", false],
      [101, "taken", null, true],
      [102, "taken", "printer", false],
      [103, "free", null, false],
      [104, "taken", null, false],
      [105, "taken", "sonarr", true],
      [106, "stopped", "backrest", false],
      [107, "free", null, false],
      [108, "free", null, false],
    ]);
    expect(scan.firstFree).toBe("10.0.0.103");
    expect(scan.freeCount).toBe(3);
    expect(scan.docker).toEqual({ used: true, error: null, containers: 4 });
  });
});
