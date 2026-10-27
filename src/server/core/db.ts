import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export interface Migration {
  version: number;
  sql: string;
}

/** Opens (creating if needed) the single SQLite file all state lives in. */
export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "kondo.db");
  const isNew = !existsSync(file);
  const db = new DatabaseSync(file);
  // Secrets live in here too.
  if (isNew) chmodSync(file, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- Every commit reaches the disk before Kondo acts on it: a swap is recorded before the
    -- library changes, and a power cut mustn't undo that record.
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS migrations (
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (scope, version)
    );
  `);
  return db;
}

/** Applies a scope's (core's or a tool's) migrations that haven't run yet. */
export function migrate(db: Db, scope: string, migrations: Migration[]): void {
  const applied = new Set(
    db
      .prepare("SELECT version FROM migrations WHERE scope = ?")
      .all(scope)
      .map((row) => Number(row.version)),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));
  for (const m of pending) {
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO migrations (scope, version, applied_at) VALUES (?, ?, ?)").run(
        scope,
        m.version,
        new Date().toISOString(),
      );
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const coreMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE secrets (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        type TEXT NOT NULL,
        slot TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        force INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        result TEXT,
        error TEXT,
        progress REAL,
        progress_text TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX jobs_by_state ON jobs (state, slot, priority DESC, id);
      CREATE INDEX jobs_by_tool ON jobs (tool, id DESC);
      CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key)
        WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running', 'paused');
      CREATE TABLE job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX job_logs_by_job ON job_logs (job_id, id);
    `,
  },
  {
    version: 2,
    sql: `CREATE TABLE core_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  },
];
