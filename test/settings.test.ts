import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import { EventBus } from "../src/server/core/events.js";
import { SettingsStore, SettingsValidationError } from "../src/server/core/settings.js";
import type { KondoEvent } from "../src/shared/api.js";
import type { SettingsSection } from "../src/shared/settings.js";
import { tempDir } from "./helpers.js";

const section: SettingsSection = {
  scope: "demo",
  title: "Demo",
  group: "integration",
  fields: [
    { key: "url", label: "URL", type: "url" },
    { key: "token", label: "Token", type: "secret" },
    { key: "port", label: "Port", type: "number", default: 80, min: 1, max: 65535 },
    { key: "start", label: "Start", type: "time", default: "02:00" },
    { key: "zone", label: "Zone", type: "timezone", default: "UTC" },
    { key: "on", label: "On", type: "boolean", default: false },
  ],
};

function store() {
  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  const events = new EventBus();
  const seen: KondoEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const settings = new SettingsStore(db, events);
  settings.register(section);
  return { settings, seen };
}

describe("settings", () => {
  it("fills in defaults and keeps secrets out of plain values", () => {
    const { settings } = store();
    expect(settings.values("demo")).toEqual({ port: 80, start: "02:00", zone: "UTC", on: false });
    expect(settings.publicValues().demo?.token).toEqual({ set: false });
  });

  it("saves cleaned values and announces the change", () => {
    const { settings, seen } = store();
    settings.update("demo", {
      url: " http://plex:32400/ ",
      port: "8080",
      on: true,
      zone: "Europe/Dublin",
    });
    expect(settings.values("demo")).toMatchObject({
      url: "http://plex:32400",
      port: 8080,
      on: true,
      zone: "Europe/Dublin",
    });
    expect(seen).toContainEqual({ type: "settings.changed", scope: "demo" });
  });

  it("treats secrets as write-only: blank keeps, text replaces, null removes", () => {
    const { settings } = store();
    settings.update("demo", { token: "abc" });
    expect(settings.secret("demo", "token")).toBe("abc");
    expect(settings.publicValues().demo?.token).toEqual({ set: true });
    settings.update("demo", { token: "" });
    expect(settings.secret("demo", "token")).toBe("abc");
    settings.update("demo", { token: "xyz" });
    expect(settings.secret("demo", "token")).toBe("xyz");
    settings.update("demo", { token: null });
    expect(settings.secret("demo", "token")).toBeNull();
  });

  it("rejects bad values per field and saves nothing", () => {
    const { settings } = store();
    try {
      settings.update("demo", { url: "plex", port: 0, start: "2am", zone: "Mars/Base", nope: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError);
      expect(Object.keys((error as SettingsValidationError).fields).sort()).toEqual(
        ["nope", "port", "start", "url", "zone"].sort(),
      );
    }
    expect(settings.values("demo").port).toBe(80);
  });

  it("knows when the listed fields are all filled in", () => {
    const { settings } = store();
    expect(settings.hasValues("demo", ["url", "token"])).toBe(false);
    settings.update("demo", { url: "http://x", token: "t" });
    expect(settings.hasValues("demo", ["url", "token"])).toBe(true);
  });
});
