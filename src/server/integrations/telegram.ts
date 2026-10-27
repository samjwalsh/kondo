import type { SettingsSection, TestResult } from "../../shared/settings.js";
import type { SettingsStore } from "../core/settings.js";
import { errorMessage, requestJson } from "./http.js";

export const telegramSettings: SettingsSection = {
  scope: "telegram",
  title: "Telegram alerts",
  group: "integration",
  description: "Where Kondo sends problems (and the all-clear when they're fixed).",
  testable: true,
  fields: [
    {
      key: "botToken",
      label: "Bot token",
      type: "secret",
      help: "Create a bot with @BotFather and paste the token it gives you.",
    },
    {
      key: "chatId",
      label: "Chat ID",
      type: "string",
      help: "Leave empty, send your bot any message, then press Test: Kondo finds and saves the chat ID.",
    },
    {
      key: "morningSummary",
      label: "Send a short summary when the night window ends",
      type: "boolean",
      default: true,
      help: "A few lines from each tool: what it did since the last one. Sent every day, so you know Kondo is running.",
    },
  ],
};

interface TelegramReply<T> {
  ok: boolean;
  description?: string;
  result?: T;
}

interface Update {
  message?: { chat?: { id?: number; title?: string; first_name?: string; username?: string } };
}

export class Telegram {
  constructor(private readonly settings: SettingsStore) {}

  configured(): boolean {
    return this.settings.hasValues("telegram", ["botToken", "chatId"]);
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const token = this.settings.secret("telegram", "botToken");
    if (!token) throw new Error("No bot token saved");
    let reply: TelegramReply<T>;
    try {
      reply = await requestJson<TelegramReply<T>>(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      // Never let the token (part of the URL) reach logs or the UI.
      throw new Error(errorMessage(error).replaceAll(token, "…"));
    }
    if (!reply.ok) throw new Error(reply.description ?? "Telegram refused the request");
    return reply.result as T;
  }

  async send(text: string): Promise<void> {
    const chatId = String(this.settings.values("telegram").chatId ?? "");
    await this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  }

  async test(): Promise<TestResult> {
    if (!this.settings.secret("telegram", "botToken")) {
      return { ok: false, message: "Save the bot token first." };
    }
    try {
      if (!this.settings.hasValues("telegram", ["chatId"])) {
        const updates = await this.call<Update[]>("getUpdates", { limit: 20 });
        const chat = updates.map((u) => u.message?.chat).find((c) => c?.id !== undefined);
        if (!chat?.id) {
          return {
            ok: false,
            message: "Send your bot a message in Telegram first, then press Test again.",
          };
        }
        this.settings.update("telegram", { chatId: String(chat.id) });
        const who = chat.title ?? chat.first_name ?? chat.username ?? "your chat";
        await this.send("Kondo can send you alerts here.");
        return {
          ok: true,
          message: `Found ${who} (${chat.id}), saved it, and sent a test message.`,
        };
      }
      await this.send("Kondo can send you alerts here.");
      return { ok: true, message: "Test message sent — check Telegram." };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }
}
