import type { Db, Migration } from "../../server/core/db.js";
import type { MissingRun } from "./shared.js";

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE missing_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        app TEXT NOT NULL,
        missing INTEGER NOT NULL,
        searched TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX missing_runs_by_time ON missing_runs (at);
      CREATE TABLE missing_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
];

function toRun(r: Record<string, unknown>): MissingRun {
  return {
    id: Number(r.id),
    at: String(r.at),
    app: String(r.app) as MissingRun["app"],
    missing: Number(r.missing),
    searched: JSON.parse(String(r.searched)) as string[],
    error: r.error === null || r.error === undefined ? null : String(r.error),
  };
}

export class MissingStore {
  constructor(private readonly db: Db) {}

  log(run: Omit<MissingRun, "id">): void {
    this.db
      .prepare(
        "INSERT INTO missing_runs (at, app, missing, searched, error) VALUES (?, ?, ?, ?, ?)",
      )
      .run(run.at, run.app, run.missing, JSON.stringify(run.searched), run.error);
  }

  runs(options: { since?: string; limit: number }): MissingRun[] {
    const rows = options.since
      ? this.db
          .prepare("SELECT * FROM missing_runs WHERE at >= ? ORDER BY id DESC LIMIT ?")
          .all(options.since, options.limit)
      : this.db.prepare("SELECT * FROM missing_runs ORDER BY id DESC LIMIT ?").all(options.limit);
    return rows.map(toRun);
  }

  lastRunAt(): string | null {
    const row = this.db.prepare("SELECT value FROM missing_meta WHERE key = 'lastRunAt'").get();
    return row ? String(row.value) : null;
  }

  saveLastRunAt(at: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO missing_meta (key, value) VALUES ('lastRunAt', ?)")
      .run(at);
  }
}
