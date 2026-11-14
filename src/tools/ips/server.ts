import { defineTool } from "../../server/core/tools.js";
import { errorMessage } from "../../server/integrations/http.js";
import { type SettingsSection, splitLines } from "../../shared/settings.js";
import { localNetwork, scanRange } from "./scan.js";
import type { IpScan } from "./shared.js";

export const ipsSettings: SettingsSection = {
  scope: "ips",
  title: "Free IPs",
  group: "tool",
  description:
    "The range on Kondo's own network (the last number of the address) to look for a free address in, e.g. for a new Docker container.",
  fields: [
    { key: "from", label: "From", type: "number", default: 100, min: 1, max: 254 },
    { key: "to", label: "To", type: "number", default: 200, min: 1, max: 254 },
    {
      key: "reserved",
      label: "Also taken",
      type: "lines",
      default: "",
      help: "Addresses that are in use but may not answer, e.g. a device that's often off. One per line: the last number or the full address. Stopped containers are found on their own once Unraid is set up.",
    },
  ],
};

const FRESH_MS = 30_000;

export default defineTool({
  id: "ips",
  name: "Free IPs",
  description: "Shows the lowest free address in a range of the local network.",
  settings: [ipsSettings],

  register(ctx) {
    let latest: IpScan | null = null;
    let inFlight: Promise<IpScan> | null = null;

    const scan = (): Promise<IpScan> => {
      inFlight ??= (async () => {
        const values = ctx.settings.values("ips");
        const network = localNetwork();
        try {
          if (!network) throw new Error("This machine has no IPv4 network address");
          const unraid = ctx.integrations.unraid;
          let containers = null;
          let dockerError: string | null = null;
          if (unraid.configured()) {
            try {
              containers = await unraid.containers();
            } catch (error) {
              dockerError = `Couldn't read containers from Unraid: ${errorMessage(error)}`;
            }
          }
          const known = new Map<string, string>();
          try {
            const host = new URL(String(ctx.settings.values("unraid").url ?? "")).hostname;
            if (host) known.set(host, "Unraid");
          } catch {
            // No Unraid address set.
          }
          latest = await scanRange({
            known,
            containers,
            dockerError,
            network,
            from: Number(values.from),
            to: Number(values.to),
            reserved: splitLines(values.reserved),
          });
        } catch (error) {
          latest = {
            network: "",
            from: "",
            to: "",
            addresses: [],
            firstFree: null,
            freeCount: 0,
            docker: { used: false, error: null, containers: 0 },
            scannedAt: new Date().toISOString(),
            error: errorMessage(error),
          };
        }
        return latest;
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };

    ctx.routes((app) => {
      app.get<{ Querystring: { refresh?: string } }>("/scan", async (request) => {
        const fresh = latest && Date.now() - Date.parse(latest.scannedAt) < FRESH_MS;
        return fresh && !request.query.refresh ? latest : scan();
      });
    });

    ctx.setCard(() => {
      if (!latest) return { status: "ok", lines: ["Open the page to look for a free address."] };
      if (latest.error) return { status: "warn", lines: [latest.error] };
      return {
        status: latest.firstFree ? "ok" : "warn",
        lines: [
          latest.firstFree
            ? `Lowest free: ${latest.firstFree} (${latest.freeCount} free)`
            : `Nothing free between ${latest.from} and ${latest.to}`,
        ],
      };
    });
  },
});
