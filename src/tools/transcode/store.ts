import type { Db, Migration } from "../../server/core/db.js";
import { transaction } from "../../server/core/db.js";
import { extractMediaInfo, type Probe } from "./media.js";
import { type Evaluation, outcomeOverride } from "./rules.js";
import {
  type ApprovalItem,
  type ArrMatch,
  type Decision,
  type EncodeDetails,
  type FileDetail,
  type FileFilter,
  type FileSort,
  type FileSummary,
  type FilesPage,
  type LibrarySummary,
  type Outcome,
  type OutcomeStatus,
  REASON_LABELS,
  type ReasonCode,
  type ScanInfo,
} from "./shared.js";

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE transcode_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        root TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        seen_at TEXT NOT NULL,
        probe TEXT,
        probe_error TEXT,
        probed_at TEXT,
        arr TEXT,
        decision TEXT,
        reason_code TEXT,
        reason TEXT,
        plan TEXT,
        est_bytes INTEGER,
        video_codec TEXT,
        width INTEGER,
        height INTEGER,
        video_kbps INTEGER
      );
      CREATE INDEX transcode_files_by_decision ON transcode_files (decision, reason_code);
      CREATE TABLE transcode_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        files INTEGER NOT NULL DEFAULT 0,
        probed INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE transcode_outcomes (
        file_id INTEGER PRIMARY KEY REFERENCES transcode_files (id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        encoder TEXT,
        output_path TEXT,
        output_bytes INTEGER,
        details TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX transcode_outcomes_by_status ON transcode_outcomes (status);
    `,
  },
];

/** Dedupe key of the encode job for a file (also used to find it in the core jobs table). */
export const encodeKey = (fileId: number) => `transcode:encode:${fileId}`;

const ACTIVE_ENCODE = `EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = 'transcode:encode:' || f.id
  AND j.state IN ('queued', 'running', 'paused'))`;

export interface FoundFile {
  root: string;
  size: number;
  mtimeMs: number;
}

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toSummary(row: Row): FileSummary {
  const path = String(row.path);
  const root = String(row.root);
  return {
    id: Number(row.id),
    path: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
    root,
    sizeBytes: Number(row.size),
    videoCodec: str(row.video_codec),
    width: num(row.width),
    height: num(row.height),
    videoKbps: num(row.video_kbps),
    decision: str(row.decision) as Decision | null,
    reasonCode: str(row.reason_code) as ReasonCode | null,
    reason: str(row.reason),
    estimatedBytes: num(row.est_bytes),
    outcomeStatus: str(row.outcome_status) as OutcomeStatus | null,
  };
}

function toOutcome(row: Row): Outcome {
  return {
    fileId: Number(row.file_id),
    status: String(row.status) as OutcomeStatus,
    encoder: str(row.encoder),
    outputBytes: num(row.output_bytes),
    details: row.details === null ? null : (JSON.parse(String(row.details)) as EncodeDetails),
    error: str(row.error),
    attempts: Number(row.attempts),
    updatedAt: String(row.updated_at),
  };
}

const SUMMARY_COLUMNS = `f.id, f.path, f.root, f.size, f.video_codec, f.width, f.height, f.video_kbps, f.decision,
  f.reason_code, f.reason, f.est_bytes, o.status AS outcome_status`;

const SORTS: Record<FileSort, string> = {
  saving: "(size - COALESCE(est_bytes, size)) DESC, size DESC",
  size: "size DESC",
  path: "path ASC",
};

/** Everything the transcode tool knows about the library, in SQLite. */
export class LibraryStore {
  constructor(private readonly db: Db) {}

  /**
   * Records what a scan found: new files, changed files (re-read later), and files that are
   * gone. `complete` is false when part of the library couldn't be read, so nothing is forgotten.
   */
  reconcile(
    found: Map<string, FoundFile>,
    seenAt: string,
    complete: boolean,
  ): { added: number; changed: number; removed: number } {
    return transaction(this.db, () => {
      const existing = new Map(
        this.db
          .prepare("SELECT id, path, size, mtime_ms FROM transcode_files")
          .all()
          .map((r) => [
            String(r.path),
            { id: Number(r.id), size: Number(r.size), mtime: Number(r.mtime_ms) },
          ]),
      );
      const insert = this.db.prepare(
        "INSERT INTO transcode_files (path, root, size, mtime_ms, seen_at) VALUES (?, ?, ?, ?, ?)",
      );
      const touch = this.db.prepare(
        "UPDATE transcode_files SET seen_at = ?, root = ? WHERE id = ?",
      );
      const changed = this.db.prepare(
        `UPDATE transcode_files SET size = ?, mtime_ms = ?, seen_at = ?, root = ?, probe = NULL, probe_error = NULL,
         probed_at = NULL, decision = NULL, reason_code = NULL, reason = NULL, plan = NULL, est_bytes = NULL WHERE id = ?`,
      );
      const forget = this.db.prepare("DELETE FROM transcode_outcomes WHERE file_id = ?");
      let added = 0;
      let modified = 0;
      for (const [path, f] of found) {
        const old = existing.get(path);
        if (!old) {
          insert.run(path, f.root, f.size, f.mtimeMs, seenAt);
          added++;
        } else if (old.size !== f.size || old.mtime !== f.mtimeMs) {
          changed.run(f.size, f.mtimeMs, seenAt, f.root, old.id);
          forget.run(old.id);
          modified++;
        } else {
          touch.run(seenAt, f.root, old.id);
        }
      }
      if (!complete) return { added, changed: modified, removed: 0 };
      const { changes } = this.db
        .prepare("DELETE FROM transcode_files WHERE seen_at < ?")
        .run(seenAt);
      return { added, changed: modified, removed: Number(changes) };
    });
  }

  needingProbe(): { id: number; path: string }[] {
    return this.db
      .prepare("SELECT id, path FROM transcode_files WHERE probed_at IS NULL ORDER BY path")
      .all()
      .map((r) => ({ id: Number(r.id), path: String(r.path) }));
  }

  saveProbe(id: number, probe: Probe | null, error: string | null): void {
    this.db
      .prepare("UPDATE transcode_files SET probe = ?, probe_error = ?, probed_at = ? WHERE id = ?")
      .run(probe ? JSON.stringify(probe) : null, error, new Date().toISOString(), id);
  }

  /** Rows that have been read (successfully or not), for deciding. */
  forDecision(): {
    id: number;
    path: string;
    root: string;
    probe: Probe | null;
    outcome: Pick<Outcome, "status" | "error" | "attempts"> | null;
  }[] {
    return this.db
      .prepare(
        `SELECT f.id, f.path, f.root, f.probe, o.status, o.error, o.attempts
         FROM transcode_files f LEFT JOIN transcode_outcomes o ON o.file_id = f.id
         WHERE f.probed_at IS NOT NULL`,
      )
      .all()
      .map((r) => ({
        id: Number(r.id),
        path: String(r.path),
        root: String(r.root),
        probe: r.probe === null ? null : (JSON.parse(String(r.probe)) as Probe),
        outcome:
          r.status === null
            ? null
            : {
                status: String(r.status) as OutcomeStatus,
                error: str(r.error),
                attempts: Number(r.attempts),
              },
      }));
  }

  saveDecisions(
    decisions: { id: number; evaluation: Evaluation; arr: ArrMatch | null; probe: Probe | null }[],
  ): void {
    const update = this.db.prepare(
      `UPDATE transcode_files SET decision = ?, reason_code = ?, reason = ?, plan = ?, est_bytes = ?,
       arr = ?, video_codec = ?, width = ?, height = ?, video_kbps = ? WHERE id = ?`,
    );
    transaction(this.db, () => {
      for (const { id, evaluation, arr, probe } of decisions) {
        const video = probe ? extractMediaInfo(probe).video : null;
        update.run(
          evaluation.decision,
          evaluation.reasonCode,
          evaluation.reason,
          evaluation.plan ? JSON.stringify(evaluation.plan) : null,
          evaluation.plan?.estimatedBytes ?? null,
          arr ? JSON.stringify(arr) : null,
          video?.codec ?? null,
          video?.width ?? null,
          video?.height ?? null,
          video?.kbps ?? null,
          id,
        );
      }
    });
  }

  summary(roots: string[]): LibrarySummary {
    const groups = this.db
      .prepare(
        `SELECT decision, reason_code, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes,
         COALESCE(SUM(est_bytes), 0) AS est FROM transcode_files GROUP BY decision, reason_code`,
      )
      .all();
    const out: LibrarySummary = {
      roots,
      files: 0,
      bytes: 0,
      toTranscode: { count: 0, bytes: 0, estimatedBytes: 0 },
      skipped: { count: 0, bytes: 0 },
      problems: 0,
      notYetRead: 0,
      awaitingApproval: this.countOutcomes(["awaiting-approval"]),
      byReason: [],
      lastScan: this.lastScan(),
    };
    for (const g of groups) {
      const n = Number(g.n);
      const bytes = Number(g.bytes);
      out.files += n;
      out.bytes += bytes;
      const decision = str(g.decision);
      if (decision === "transcode") {
        out.toTranscode.count += n;
        out.toTranscode.bytes += bytes;
        out.toTranscode.estimatedBytes += Number(g.est);
      } else if (decision === "skip") {
        out.skipped.count += n;
        out.skipped.bytes += bytes;
      } else if (decision === "error") {
        out.problems += n;
      } else {
        out.notYetRead += n;
      }
      const code = str(g.reason_code) as ReasonCode | null;
      if (code) out.byReason.push({ code, label: REASON_LABELS[code], count: n, bytes });
    }
    out.byReason.sort((a, b) => b.count - a.count);
    return out;
  }

  page(options: {
    filter: FileFilter;
    reason?: string;
    search?: string;
    sort: FileSort;
    limit: number;
    offset: number;
  }): FilesPage {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.filter !== "all") {
      where.push("decision = ?");
      params.push(options.filter);
    }
    if (options.reason) {
      where.push("reason_code = ?");
      params.push(options.reason);
    }
    if (options.search) {
      where.push("path LIKE ? ESCAPE '\\'");
      params.push(`%${options.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS n FROM transcode_files ${clause}`).get(...params)?.n ?? 0,
    );
    const files = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM transcode_files f LEFT JOIN transcode_outcomes o ON o.file_id = f.id
         ${clause} ORDER BY ${SORTS[options.sort]} LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset)
      .map(toSummary);
    return { total, files };
  }

  detail(id: number): FileDetail | null {
    const row = this.db
      .prepare(
        `SELECT f.*, o.status AS outcome_status, ${ACTIVE_ENCODE} AS encoding
         FROM transcode_files f LEFT JOIN transcode_outcomes o ON o.file_id = f.id WHERE f.id = ?`,
      )
      .get(id);
    if (!row) return null;
    return {
      ...toSummary(row),
      outcome: this.outcome(id),
      encoding: Boolean(row.encoding),
      info: row.probe === null ? null : extractMediaInfo(JSON.parse(String(row.probe)) as Probe),
      plan: row.plan === null ? null : JSON.parse(String(row.plan)),
      arr: row.arr === null ? null : JSON.parse(String(row.arr)),
      probeError: str(row.probe_error),
      probedAt: str(row.probed_at),
    };
  }

  /** Size and modification time recorded by the last scan. */
  sourceState(id: number): { size: number; mtimeMs: number } | null {
    const row = this.db.prepare("SELECT size, mtime_ms FROM transcode_files WHERE id = ?").get(id);
    return row ? { size: Number(row.size), mtimeMs: Number(row.mtime_ms) } : null;
  }

  outcome(fileId: number): Outcome | null {
    const row = this.db.prepare("SELECT * FROM transcode_outcomes WHERE file_id = ?").get(fileId);
    return row ? toOutcome(row) : null;
  }

  /** Records an encode result; results that rule a file out also update its decision. */
  saveOutcome(
    fileId: number,
    outcome: {
      status: OutcomeStatus;
      encoder?: string | null;
      outputPath?: string | null;
      outputBytes?: number | null;
      details?: EncodeDetails | null;
      error?: string | null;
    },
  ): Outcome {
    const now = new Date().toISOString();
    const previous = this.outcome(fileId);
    const attempts = (previous?.attempts ?? 0) + (outcome.status === "failed" ? 1 : 0);
    this.db
      .prepare(
        `INSERT INTO transcode_outcomes (file_id, status, encoder, output_path, output_bytes, details, error, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (file_id) DO UPDATE SET status = excluded.status, encoder = excluded.encoder,
           output_path = excluded.output_path, output_bytes = excluded.output_bytes, details = excluded.details,
           error = excluded.error, attempts = excluded.attempts, updated_at = excluded.updated_at`,
      )
      .run(
        fileId,
        outcome.status,
        outcome.encoder ?? null,
        outcome.outputPath ?? null,
        outcome.outputBytes ?? null,
        outcome.details ? JSON.stringify(outcome.details) : null,
        outcome.error ?? null,
        attempts,
        now,
        now,
      );
    const saved = this.outcome(fileId) as Outcome;
    const override = outcomeOverride(saved);
    if (override) {
      this.db
        .prepare(
          "UPDATE transcode_files SET decision = ?, reason_code = ?, reason = ? WHERE id = ?",
        )
        .run(override.decision, override.reasonCode, override.reason, fileId);
    }
    return saved;
  }

  setOutcomeStatus(fileId: number, status: OutcomeStatus): Outcome | null {
    const current = this.outcome(fileId);
    if (!current) return null;
    return this.saveOutcome(fileId, {
      status,
      encoder: current.encoder,
      outputPath: status === "rejected" ? null : this.outputPath(fileId),
      outputBytes: current.outputBytes,
      details: current.details,
      error: current.error,
    });
  }

  outputPath(fileId: number): string | null {
    const row = this.db
      .prepare("SELECT output_path FROM transcode_outcomes WHERE file_id = ?")
      .get(fileId);
    return row ? str(row.output_path) : null;
  }

  countOutcomes(statuses: OutcomeStatus[]): number {
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM transcode_outcomes WHERE status IN (${placeholders})`)
      .get(...statuses);
    return Number(row?.n ?? 0);
  }

  /** File ids that still have results on disk (waiting or approved). */
  idsWithResults(): Set<number> {
    return new Set(
      this.db
        .prepare(
          "SELECT file_id FROM transcode_outcomes WHERE status IN ('awaiting-approval', 'approved')",
        )
        .all()
        .map((r) => Number(r.file_id)),
    );
  }

  approvals(): ApprovalItem[] {
    return this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, f.plan FROM transcode_files f JOIN transcode_outcomes o ON o.file_id = f.id
         WHERE o.status IN ('awaiting-approval', 'approved') ORDER BY o.updated_at`,
      )
      .all()
      .map((row) => ({
        file: toSummary(row),
        outcome: this.outcome(Number(row.id)) as Outcome,
        plan: row.plan === null ? null : JSON.parse(String(row.plan)),
      }));
  }

  /**
   * The next files to encode: marked for transcoding, not already queued, and either never
   * tried or failed once. Biggest saving first.
   */
  nextCandidates(limit: number): { id: number; path: string }[] {
    return this.db
      .prepare(
        `SELECT f.id, f.path FROM transcode_files f LEFT JOIN transcode_outcomes o ON o.file_id = f.id
         WHERE f.decision = 'transcode' AND (o.file_id IS NULL OR (o.status = 'failed' AND o.attempts < 2))
           AND NOT ${ACTIVE_ENCODE}
         ORDER BY (f.size - COALESCE(f.est_bytes, f.size)) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => ({ id: Number(r.id), path: String(r.path) }));
  }

  startScan(): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO transcode_scans (started_at) VALUES (?)")
      .run(new Date().toISOString());
    // Keep the last 50 scans.
    this.db
      .prepare(
        "DELETE FROM transcode_scans WHERE id <= (SELECT id FROM transcode_scans ORDER BY id DESC LIMIT 1 OFFSET 50)",
      )
      .run();
    return Number(lastInsertRowid);
  }

  finishScan(
    id: number,
    stats: { files: number; probed: number; errors: number; error: string | null },
  ): void {
    this.db
      .prepare(
        "UPDATE transcode_scans SET finished_at = ?, files = ?, probed = ?, errors = ?, error = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), stats.files, stats.probed, stats.errors, stats.error, id);
  }

  /** Forgets a scan that was cancelled or cut short by a restart (it isn't a failure). */
  discardScan(id: number): void {
    this.db.prepare("DELETE FROM transcode_scans WHERE id = ?").run(id);
  }

  lastScan(): ScanInfo | null {
    const row = this.db
      .prepare(
        "SELECT * FROM transcode_scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (!row) return null;
    return {
      startedAt: String(row.started_at),
      finishedAt: str(row.finished_at),
      files: Number(row.files),
      probed: Number(row.probed),
      errors: Number(row.errors),
      error: str(row.error),
    };
  }
}
