import type { Db, Migration } from "../../server/core/db.js";
import type { CheckInfo, FakeAction, FakeEntry } from "./shared.js";

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE downloads_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        hash TEXT NOT NULL,
        name TEXT NOT NULL,
        app TEXT,
        what TEXT,
        indexer TEXT,
        bad_files TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX downloads_log_by_hash ON downloads_log (hash, id);
      CREATE INDEX downloads_log_by_time ON downloads_log (at);
      CREATE TABLE downloads_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE downloads_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'fake';
      ALTER TABLE downloads_log ADD COLUMN problem TEXT;
      -- When each unfinished download last got further, so a stalled one can be spotted.
      CREATE TABLE downloads_progress (
        hash TEXT PRIMARY KEY,
        downloaded INTEGER NOT NULL,
        since TEXT NOT NULL
      );
    `,
  },
];

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toEntry(r: Record<string, unknown>): FakeEntry {
  return {
    id: Number(r.id),
    at: String(r.at),
    hash: String(r.hash),
    name: String(r.name),
    kind: (str(r.kind) ?? "fake") as FakeEntry["kind"],
    app: str(r.app) as FakeEntry["app"],
    what: str(r.what),
    indexer: str(r.indexer),
    badFiles: JSON.parse(String(r.bad_files)) as string[],
    problem: str(r.problem),
    action: String(r.action) as FakeAction,
    detail: str(r.detail),
  };
}

export class DownloadsStore {
  constructor(private readonly db: Db) {}

  log(entry: Omit<FakeEntry, "id" | "at"> & { at?: string }): void {
    this.db
      .prepare(
        `INSERT INTO downloads_log
           (at, hash, name, kind, app, what, indexer, bad_files, problem, action, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.at ?? new Date().toISOString(),
        entry.hash,
        entry.name,
        entry.kind,
        entry.app,
        entry.what,
        entry.indexer,
        JSON.stringify(entry.badFiles),
        entry.problem,
        entry.action,
        entry.detail,
      );
  }

  /** The latest line about a torrent, so a check doesn't repeat itself every few minutes. */
  last(hash: string): FakeEntry | null {
    const row = this.db
      .prepare("SELECT * FROM downloads_log WHERE hash = ? ORDER BY id DESC LIMIT 1")
      .get(hash);
    return row ? toEntry(row) : null;
  }

  entries(options: { since?: string; limit: number }): FakeEntry[] {
    const rows = options.since
      ? this.db
          .prepare("SELECT * FROM downloads_log WHERE at >= ? ORDER BY id DESC LIMIT ?")
          .all(options.since, options.limit)
      : this.db.prepare("SELECT * FROM downloads_log ORDER BY id DESC LIMIT ?").all(options.limit);
    return rows.map(toEntry);
  }

  countRemoved(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM downloads_log WHERE action = 'removed'")
      .get();
    return Number(row?.n ?? 0);
  }

  /** When the download last got further, or null if it hasn't been seen downloading. */
  progress(hash: string): { downloaded: number; since: string } | null {
    const row = this.db
      .prepare("SELECT downloaded, since FROM downloads_progress WHERE hash = ?")
      .get(hash);
    return row ? { downloaded: Number(row.downloaded), since: String(row.since) } : null;
  }

  saveProgress(hash: string, downloaded: number, since: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO downloads_progress (hash, downloaded, since) VALUES (?, ?, ?)",
      )
      .run(hash, downloaded, since);
  }

  /** Forgets every download except these (finished, stopped, removed). */
  keepProgress(hashes: string[]): void {
    const keep = new Set(hashes);
    const rows = this.db.prepare("SELECT hash FROM downloads_progress").all();
    const drop = this.db.prepare("DELETE FROM downloads_progress WHERE hash = ?");
    for (const row of rows) if (!keep.has(String(row.hash))) drop.run(String(row.hash));
  }

  lastCheck(): CheckInfo | null {
    const row = this.db.prepare("SELECT value FROM downloads_meta WHERE key = 'lastCheck'").get();
    return row ? (JSON.parse(String(row.value)) as CheckInfo) : null;
  }

  saveCheck(info: CheckInfo): void {
    this.db
      .prepare("INSERT OR REPLACE INTO downloads_meta (key, value) VALUES ('lastCheck', ?)")
      .run(JSON.stringify(info));
  }
}
