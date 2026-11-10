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
  {
    version: 2,
    sql: `
      ALTER TABLE missing_runs ADD COLUMN upgrades INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE missing_searched (
        app TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (app, item_id)
      );
    `,
  },
];

function toRun(r: Record<string, unknown>): MissingRun {
  return {
    id: Number(r.id),
    at: String(r.at),
    app: String(r.app) as MissingRun["app"],
    missing: Number(r.missing),
    upgrades: Number(r.upgrades ?? 0),
    searched: JSON.parse(String(r.searched)) as string[],
    error: r.error === null || r.error === undefined ? null : String(r.error),
  };
}

export class MissingStore {
  constructor(private readonly db: Db) {}

  log(run: Omit<MissingRun, "id">): void {
    this.db
      .prepare(
        "INSERT INTO missing_runs (at, app, missing, upgrades, searched, error) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(run.at, run.app, run.missing, run.upgrades, JSON.stringify(run.searched), run.error);
  }

  runs(options: { since?: string; limit: number }): MissingRun[] {
    const rows = options.since
      ? this.db
          .prepare("SELECT * FROM missing_runs WHERE at >= ? ORDER BY id DESC LIMIT ?")
          .all(options.since, options.limit)
      : this.db.prepare("SELECT * FROM missing_runs ORDER BY id DESC LIMIT ?").all(options.limit);
    return rows.map(toRun);
  }

  /** When Kondo last asked for each item to be searched (Radarr doesn't say for every list). */
  searchedAt(app: string): Map<number, string> {
    return new Map(
      this.db
        .prepare("SELECT item_id, at FROM missing_searched WHERE app = ?")
        .all(app)
        .map((r) => [Number(r.item_id), String(r.at)]),
    );
  }

  markSearched(app: string, ids: number[], at: string): void {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO missing_searched (app, item_id, at) VALUES (?, ?, ?)",
    );
    for (const id of ids) insert.run(app, id, at);
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
