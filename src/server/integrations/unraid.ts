import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, requestJson } from "./http.js";

export const unraidSettings: SettingsSection = {
  scope: "unraid",
  title: "Unraid",
  group: "integration",
  description:
    "The Unraid server running the Docker containers. Used by Free IPs to see which addresses containers are set to use, stopped ones included.",
  testable: true,
  fields: [
    {
      key: "url",
      label: "Address",
      type: "url",
      default: "",
      placeholder: "http://tower",
    },
    {
      key: "apiKey",
      label: "API key",
      type: "secret",
      help: "Unraid → Settings → Management Access → API Keys → Create. Read access to Docker is all Kondo needs.",
    },
  ],
};

export interface UnraidContainer {
  name: string;
  running: boolean;
  /** IPv4 addresses the container has or is set to have, on any network. */
  ips: string[];
}

interface RawContainer {
  names?: string[];
  state?: "RUNNING" | "PAUSED" | "EXITED";
  networkSettings?: unknown;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Docker's network settings, as Unraid passes them on: each network has the address
 * it was given (IPAddress, empty while stopped) and the fixed one it asked for
 * (IPAMConfig.IPv4Address). Takes both, whatever the key's case.
 */
export function containerIps(networkSettings: unknown): string[] {
  const out = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string" && /^(ipaddress|ipv4address)$/i.test(key) && IPV4.test(v)) {
        out.add(v);
      } else walk(v);
    }
  };
  walk(networkSettings);
  return [...out];
}

export class UnraidClient {
  constructor(private readonly settings: SettingsStore) {}

  configured(): boolean {
    return this.settings.hasValues("unraid", ["url", "apiKey"]);
  }

  private async query<T>(query: string): Promise<T> {
    const url = String(this.settings.values("unraid").url ?? "").replace(/\/+$/, "");
    const body = await requestJson<{ data?: T; errors?: { message: string }[] }>(`${url}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.settings.secret("unraid", "apiKey") ?? "",
      },
      body: JSON.stringify({ query }),
      timeoutMs: 15_000,
    });
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
    if (!body.data) throw new Error("Unraid returned no data");
    return body.data;
  }

  async containers(): Promise<UnraidContainer[]> {
    const data = await this.query<{ docker: { containers: RawContainer[] } }>(
      "{ docker { containers { names state networkSettings } } }",
    );
    return data.docker.containers.map((c) => ({
      name: (c.names?.[0] ?? "?").replace(/^\//, ""),
      running: c.state === "RUNNING" || c.state === "PAUSED",
      ips: containerIps(c.networkSettings),
    }));
  }

  async test(): Promise<TestResult> {
    try {
      if (!this.configured()) return { ok: false, message: "Set the address and API key first" };
      const all = await this.containers();
      const stopped = all.filter((c) => !c.running).length;
      return { ok: true, message: `Found ${all.length} containers (${stopped} stopped)` };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }
}
