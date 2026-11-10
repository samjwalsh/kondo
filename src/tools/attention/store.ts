import type { Db, Migration } from "../../server/core/db.js";
import type { AttentionItem, AttentionKind } from "./shared.js";

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Every problem currently seen, with when it was first seen (so only lasting ones are reported).
      CREATE TABLE attention_items (
        key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        app TEXT NOT NULL,
        grp TEXT NOT NULL,
        what TEXT NOT NULL,
        detail TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE INDEX attention_items_by_source ON attention_items (source);
      CREATE TABLE attention_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
];

export interface SeenItem {
  /** Unique within its source. */
  id: string;
  kind: AttentionKind;
  app: string;
  group: string;
  what: string;
  detail?: string | null;
}

function toItem(r: Record<string, unknown>): AttentionItem {
  return {
    key: String(r.key),
    kind: String(r.kind) as AttentionKind,
    app: String(r.app),
    group: String(r.grp),
    what: String(r.what),
    detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
  };
}

export class AttentionStore {
  constructor(private readonly db: Db) {}

  /**
   * Records what one source (e.g. "sonarr:queue") shows now: new problems start their clock,
   * ongoing ones keep it, and ones that are gone are forgotten.
   */
  reconcile(source: string, items: SeenItem[], at: string): void {
    const upsert = this.db.prepare(
      `INSERT INTO attention_items (key, source, kind, app, grp, what, detail, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, grp = excluded.grp, what = excluded.what,
         detail = excluded.detail, last_seen = excluded.last_seen`,
    );
    const keys = new Set<string>();
    for (const item of items) {
      const key = `${source}:${item.id}`;
      keys.add(key);
      upsert.run(
        key,
        source,
        item.kind,
        item.app,
        item.group,
        item.what,
        item.detail ?? null,
        at,
        at,
      );
    }
    const stale = this.db
      .prepare("SELECT key FROM attention_items WHERE source = ?")
      .all(source)
      .map((r) => String(r.key))
      .filter((key) => !keys.has(key));
    const remove = this.db.prepare("DELETE FROM attention_items WHERE key = ?");
    for (const key of stale) remove.run(key);
  }

  items(): AttentionItem[] {
    return this.db
      .prepare("SELECT * FROM attention_items ORDER BY first_seen, grp, what")
      .all()
      .map(toItem);
  }

  meta<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM attention_meta WHERE key = ?").get(key);
    return row ? (JSON.parse(String(row.value)) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO attention_meta (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  }
}
