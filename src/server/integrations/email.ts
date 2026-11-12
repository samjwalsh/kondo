import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, HttpError } from "./http.js";

export const emailSettings: SettingsSection = {
  scope: "email",
  title: "Email (Resend)",
  group: "integration",
  description:
    "How Kondo sends email to other people, through Resend's API. The sending domain must be verified in Resend.",
  testable: true,
  fields: [
    {
      key: "apiKey",
      label: "Resend API key",
      type: "secret",
      help: "Resend → API Keys → Create, with sending access for your domain only.",
    },
    {
      key: "fromAddress",
      label: "From address",
      type: "string",
      default: "",
      placeholder: "plex@example.com",
      help: "On the domain verified in Resend. Replies go here, so forward it to yourself.",
    },
    { key: "fromName", label: "From name", type: "string", default: "", placeholder: "Plex" },
    {
      key: "testTo",
      label: "Send test emails to",
      type: "string",
      default: "",
      help: "Leave empty to send them to the From address.",
    },
  ],
};

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend ignores a repeat with the same key (for 24 h), so a retry can't send twice. */
  idempotencyKey?: string;
}

export class Email {
  constructor(
    private readonly settings: SettingsStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  configured(): boolean {
    return this.settings.hasValues("email", ["apiKey", "fromAddress"]);
  }

  private from(): string {
    const v = this.settings.values("email");
    const address = String(v.fromAddress ?? "");
    const name = String(v.fromName ?? "").replace(/["<>]/g, "");
    return name ? `${name} <${address}>` : address;
  }

  async send(message: EmailMessage): Promise<void> {
    const key = this.settings.secret("email", "apiKey");
    if (!key) throw new Error("No Resend API key saved");
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: this.from(),
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new HttpError(`Couldn't reach Resend (${errorMessage(error)})`);
    }
    if (!response.ok) {
      // Resend explains what's wrong (unverified domain, bad key…) in the body.
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new HttpError(
        `Resend refused the email: HTTP ${response.status}${body.message ? ` — ${body.message}` : ""}`,
        response.status,
      );
    }
  }

  async test(): Promise<TestResult> {
    if (!this.configured())
      return { ok: false, message: "Fill in the API key and From address first." };
    const v = this.settings.values("email");
    const to = String(v.testTo || v.fromAddress);
    try {
      await this.send({
        to,
        subject: "Test email from Kondo",
        text: "Kondo can send email.",
        html: "<p>Kondo can send email.</p>",
      });
      return { ok: true, message: `Sent a test email to ${to}.` };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }
}
