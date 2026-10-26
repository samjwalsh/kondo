import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, requestJson } from "./http.js";

export const kumaSettings: SettingsSection = {
  scope: "kuma",
  title: "Uptime Kuma heartbeat",
  group: "integration",
  description:
    "Kondo checks in with an Uptime Kuma Push monitor while it's healthy. If Kondo dies, hangs or the machine is off, the check-ins stop and Kuma alerts you.",
  testable: true,
  fields: [
    {
      key: "pushUrl",
      label: "Push URL",
      type: "secret",
      help: "In Uptime Kuma: Add New Monitor → Push, then paste its Push URL. Give that monitor a heartbeat interval a little longer than Kondo's (e.g. 120 s).",
    },
    {
      key: "intervalSeconds",
      label: "Check in every (seconds)",
      type: "number",
      default: 60,
      min: 20,
      max: 600,
    },
  ],
};

export class Kuma {
  constructor(private readonly settings: SettingsStore) {}

  configured(): boolean {
    return this.settings.hasValues("kuma", ["pushUrl"]);
  }

  intervalMs(): number {
    return Number(this.settings.values("kuma").intervalSeconds ?? 60) * 1000;
  }

  async push(status: "up" | "down", message: string): Promise<void> {
    const pushUrl = this.settings.secret("kuma", "pushUrl");
    if (!pushUrl) throw new Error("No push URL saved");
    const url = new URL(pushUrl);
    url.searchParams.set("status", status);
    url.searchParams.set("msg", message.slice(0, 200));
    url.searchParams.set("ping", "");
    let reply: { ok?: boolean; msg?: string };
    try {
      reply = await requestJson<{ ok?: boolean; msg?: string }>(url.toString());
    } catch (error) {
      // The push token is part of the URL; keep it out of messages.
      throw new Error(errorMessage(error).replaceAll(url.pathname, "/api/push/…"));
    }
    if (!reply.ok) throw new Error(reply.msg ?? "Uptime Kuma refused the heartbeat");
  }

  async test(): Promise<TestResult> {
    if (!this.configured()) return { ok: false, message: "Save the push URL first." };
    try {
      await this.push("up", "Kondo test");
      return { ok: true, message: "Heartbeat accepted by Uptime Kuma." };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }
}
