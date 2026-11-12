import type { Db, Migration } from "../../server/core/db.js";
import type { Notice, NoticeStatus } from "./shared.js";

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE request_notices (
        request_id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        status TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        user TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX request_notices_by_time ON request_notices (at);
      CREATE TABLE requests_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
];

function toNotice(r: Record<string, unknown>): Notice {
  return {
    requestId: Number(r.request_id),
    at: String(r.at),
    status: String(r.status) as NoticeStatus,
    type: String(r.type) as Notice["type"],
    title: String(r.title),
    detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
    user: String(r.user),
    attempts: Number(r.attempts),
    error: r.error === null || r.error === undefined ? null : String(r.error),
  };
}

export class RequestsStore {
  constructor(private readonly db: Db) {}

  get(requestId: number): Notice | null {
    const row = this.db
      .prepare("SELECT * FROM request_notices WHERE request_id = ?")
      .get(requestId);
    return row ? toNotice(row) : null;
  }

  /** Request ids that need nothing more (everything but failures still being retried). */
  done(maxAttempts: number): Set<number> {
    return new Set(
      this.db
        .prepare("SELECT request_id FROM request_notices WHERE status != 'failed' OR attempts >= ?")
        .all(maxAttempts)
        .map((r) => Number(r.request_id)),
    );
  }

  save(notice: Notice): void {
    this.db
      .prepare(
        `INSERT INTO request_notices (request_id, at, status, type, title, detail, user, attempts, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id) DO UPDATE SET at = excluded.at, status = excluded.status,
           type = excluded.type, title = excluded.title, detail = excluded.detail,
           user = excluded.user, attempts = excluded.attempts, error = excluded.error`,
      )
      .run(
        notice.requestId,
        notice.at,
        notice.status,
        notice.type,
        notice.title,
        notice.detail,
        notice.user,
        notice.attempts,
        notice.error,
      );
  }

  /** Recent notices, newest first; "before" ones (from the first check) left out. */
  recent(options: { since?: string; limit: number }): Notice[] {
    const rows = options.since
      ? this.db
          .prepare(
            "SELECT * FROM request_notices WHERE status != 'before' AND at >= ? ORDER BY at DESC LIMIT ?",
          )
          .all(options.since, options.limit)
      : this.db
          .prepare(
            "SELECT * FROM request_notices WHERE status != 'before' ORDER BY at DESC LIMIT ?",
          )
          .all(options.limit);
    return rows.map(toNotice);
  }

  meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM requests_meta WHERE key = ?").get(key);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM requests_meta WHERE key = ?").run(key);
    else
      this.db
        .prepare("INSERT OR REPLACE INTO requests_meta (key, value) VALUES (?, ?)")
        .run(key, value);
  }
}
