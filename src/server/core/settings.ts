import {
  type FieldSpec,
  type FieldValue,
  type PublicValue,
  type SettingsSection,
  type SettingsUpdate,
  splitLines,
} from "../../shared/settings.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";

export class SettingsValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("Some settings are invalid");
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Returns the cleaned value, or throws a message for the user. */
function validateField(field: FieldSpec, raw: unknown): FieldValue {
  switch (field.type) {
    case "boolean":
      if (typeof raw !== "boolean") throw "Must be on or off";
      return raw;
    case "number": {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) throw "Must be a number";
      if (field.min !== undefined && n < field.min) throw `Must be at least ${field.min}`;
      if (field.max !== undefined && n > field.max) throw `Must be at most ${field.max}`;
      return n;
    }
    case "time": {
      if (typeof raw !== "string" || !TIME.test(raw.trim())) throw "Use 24-hour HH:MM, e.g. 02:00";
      return raw.trim();
    }
    case "select": {
      if (typeof raw !== "string" || !field.options?.some((o) => o.value === raw)) {
        throw "Pick one of the options";
      }
      return raw;
    }
    case "timezone": {
      if (typeof raw !== "string" || !isValidTimeZone(raw.trim())) {
        throw "Use a time zone name such as Europe/Dublin";
      }
      return raw.trim();
    }
    case "url": {
      if (typeof raw !== "string") throw "Must be text";
      const value = raw.trim();
      if (value === "") return "";
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw "Must be a full address, e.g. http://192.168.0.10:8989";
      }
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw "Must start with http:// or https://";
      return value.replace(/\/+$/, "");
    }
    case "lines": {
      if (typeof raw !== "string") throw "Must be text";
      if (raw.length > 10_000) throw "Too long";
      return splitLines(raw).join("\n");
    }
    case "string":
    case "secret": {
      if (typeof raw !== "string") throw "Must be text";
      if (raw.length > 2000) throw "Too long";
      return raw.trim();
    }
  }
}

export class SettingsStore {
  private readonly sectionsByScope = new Map<string, SettingsSection>();

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  register(section: SettingsSection): void {
    if (this.sectionsByScope.has(section.scope)) {
      throw new Error(`Settings scope "${section.scope}" registered twice`);
    }
    this.sectionsByScope.set(section.scope, section);
  }

  sections(): SettingsSection[] {
    return [...this.sectionsByScope.values()];
  }

  /** Non-secret values for a scope, with defaults filled in. */
  values<T extends Record<string, FieldValue> = Record<string, FieldValue>>(scope: string): T {
    const section = this.section(scope);
    const stored = new Map(
      this.db
        .prepare("SELECT key, value FROM settings WHERE scope = ?")
        .all(scope)
        .map((row) => [String(row.key), JSON.parse(String(row.value)) as FieldValue]),
    );
    const out: Record<string, FieldValue> = {};
    for (const field of section.fields) {
      if (field.type === "secret") continue;
      const value = stored.get(field.key) ?? field.default;
      if (value !== undefined) out[field.key] = value;
    }
    return out as T;
  }

  secret(scope: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM secrets WHERE scope = ? AND key = ?")
      .get(scope, key);
    return row ? String(row.value) : null;
  }

  /** True when every listed field (secret or not) has a non-empty value. */
  hasValues(scope: string, keys: string[]): boolean {
    const section = this.section(scope);
    const values = this.values(scope);
    return keys.every((key) => {
      const field = section.fields.find((f) => f.key === key);
      if (!field) return false;
      if (field.type === "secret") return Boolean(this.secret(scope, key));
      const value = values[key];
      return value !== undefined && value !== "";
    });
  }

  update(scope: string, input: SettingsUpdate): void {
    const section = this.section(scope);
    const errors: Record<string, string> = {};
    const plain: [string, FieldValue][] = [];
    const secrets: [string, string | null][] = [];

    for (const [key, raw] of Object.entries(input)) {
      const field = section.fields.find((f) => f.key === key);
      if (!field) {
        errors[key] = "Unknown setting";
        continue;
      }
      if (field.type === "secret") {
        if (raw === null) secrets.push([key, null]);
        else if (typeof raw === "string" && raw.trim() !== "") secrets.push([key, raw.trim()]);
        // An empty string means "keep what's saved".
        continue;
      }
      try {
        plain.push([key, validateField(field, raw)]);
      } catch (message) {
        errors[key] = String(message);
      }
    }
    if (Object.keys(errors).length > 0) throw new SettingsValidationError(errors);

    const now = new Date().toISOString();
    const setValue = this.db.prepare(
      "INSERT INTO settings (scope, key, value) VALUES (?, ?, ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
    );
    const setSecret = this.db.prepare(
      "INSERT INTO secrets (scope, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    const deleteSecret = this.db.prepare("DELETE FROM secrets WHERE scope = ? AND key = ?");
    for (const [key, value] of plain) setValue.run(scope, key, JSON.stringify(value));
    for (const [key, value] of secrets) {
      if (value === null) deleteSecret.run(scope, key);
      else setSecret.run(scope, key, value, now);
    }
    this.events.emit({ type: "settings.changed", scope });
  }

  /** Everything the UI may see: plain values, and only whether secrets are set. */
  publicValues(): Record<string, Record<string, PublicValue>> {
    const out: Record<string, Record<string, PublicValue>> = {};
    for (const section of this.sectionsByScope.values()) {
      const values: Record<string, PublicValue> = { ...this.values(section.scope) };
      for (const field of section.fields) {
        if (field.type === "secret") {
          values[field.key] = { set: this.secret(section.scope, field.key) !== null };
        }
      }
      out[section.scope] = values;
    }
    return out;
  }

  private section(scope: string): SettingsSection {
    const section = this.sectionsByScope.get(scope);
    if (!section) throw new Error(`Unknown settings scope "${scope}"`);
    return section;
  }
}
