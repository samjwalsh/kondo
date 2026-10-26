import { useEffect, useState } from "react";
import { api } from "../../web/api.js";
import { Card, JobList } from "../../web/components.js";
import { ago, bytes, count } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import type {
  FileDetail,
  FileFilter,
  FileSort,
  FileSummary,
  FilesPage,
  LibrarySummary,
  PlannedTrack,
} from "./shared.js";

const PAGE = 50;

const FILTERS: { id: FileFilter; label: string }[] = [
  { id: "transcode", label: "To transcode" },
  { id: "skip", label: "Skipped" },
  { id: "error", label: "Couldn't read" },
  { id: "all", label: "All" },
];

const scanFinished = (event: { type: string; job?: { tool: string; state: string } }) =>
  event.type === "job.updated" &&
  event.job?.tool === "transcode" &&
  (event.job.state === "succeeded" || event.job.state === "failed");

export function TranscodePage() {
  const { data: summary, error } = useApi<LibrarySummary>(
    "/api/tools/transcode/summary",
    scanFinished,
  );
  const [filter, setFilter] = useState<FileFilter>("transcode");
  const [reason, setReason] = useState<string | null>(null);

  const pick = (f: FileFilter, r: string | null = null) => {
    setFilter(f);
    setReason(r);
  };

  return (
    <>
      <div className="page-head">
        <h1>Transcode</h1>
        <button
          type="button"
          className="primary"
          onClick={() => void api.post("/api/tools/transcode/scan")}
        >
          Scan now
        </button>
      </div>
      <p className="muted">
        A dry run: this shows what Kondo would do to every file. Nothing is changed yet.
      </p>

      {error && <p className="bad">{error}</p>}
      {summary && <Summary summary={summary} onPick={pick} />}

      <h2>Recent scans</h2>
      <JobList tool="transcode" limit={3} empty="No scans yet." />

      <h2>Files</h2>
      <FileBrowser
        filter={filter}
        reason={reason}
        onFilter={pick}
        refreshKey={summary?.lastScan?.finishedAt ?? ""}
      />
    </>
  );
}

function Summary({
  summary: s,
  onPick,
}: {
  summary: LibrarySummary;
  onPick: (filter: FileFilter, reason?: string) => void;
}) {
  if (s.roots.length === 0) {
    return (
      <Card title="Not set up">
        <p>Add the library folders under Settings → Transcode.</p>
      </Card>
    );
  }
  const saving = s.toTranscode.bytes - s.toTranscode.estimatedBytes;
  const skipped = s.byReason.filter(
    (r) => !["h264", "old-codec", "h265-high-bitrate"].includes(r.code),
  );
  return (
    <>
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">In the library</span>
          <strong>{count(s.files)}</strong>
          <span className="muted">{bytes(s.bytes)}</span>
        </div>
        <button type="button" className="tile" onClick={() => onPick("transcode")}>
          <span className="tile-label">To transcode</span>
          <strong>{count(s.toTranscode.count)}</strong>
          <span className="muted">
            {bytes(s.toTranscode.bytes)} → about {bytes(s.toTranscode.estimatedBytes)}
          </span>
        </button>
        <div className="tile">
          <span className="tile-label">Estimated saving</span>
          <strong className="good">{bytes(Math.max(0, saving))}</strong>
          <span className="muted">once their torrents are gone too</span>
        </div>
        <button type="button" className="tile" onClick={() => onPick("skip")}>
          <span className="tile-label">Skipped</span>
          <strong>{count(s.skipped.count)}</strong>
          <span className="muted">{bytes(s.skipped.bytes)}</span>
        </button>
      </div>
      {(s.problems > 0 || s.notYetRead > 0) && (
        <p className="muted">
          {s.notYetRead > 0 && `${count(s.notYetRead)} file(s) not read yet. `}
          {s.problems > 0 && (
            <button type="button" className="link bad" onClick={() => onPick("error")}>
              {count(s.problems)} couldn't be read.
            </button>
          )}
        </p>
      )}
      {skipped.length > 0 && (
        <details className="card reasons">
          <summary>Why files are skipped</summary>
          <ul>
            {skipped.map((r) => (
              <li key={r.code}>
                <button
                  type="button"
                  className="link"
                  onClick={() => onPick(r.code === "probe-failed" ? "error" : "skip", r.code)}
                >
                  {r.label}
                </button>
                <span className="muted">
                  {count(r.count)} · {bytes(r.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">
        Last scan:{" "}
        {s.lastScan
          ? `${ago(s.lastScan.finishedAt)}${s.lastScan.error ? ` — failed: ${s.lastScan.error}` : ""}`
          : "not yet"}
        . Looking in {s.roots.join(", ")}.
      </p>
    </>
  );
}

function FileBrowser({
  filter,
  reason,
  onFilter,
  refreshKey,
}: {
  filter: FileFilter;
  reason: string | null;
  onFilter: (filter: FileFilter) => void;
  refreshKey: string;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FileSort>("saving");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<FilesPage | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Wait for typing to pause before searching.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the first page when the view changes
  useEffect(() => setOffset(0), [filter, reason, query, sort]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey changes when a scan finishes, to reload the list
  useEffect(() => {
    const params = new URLSearchParams({
      filter,
      sort,
      limit: String(PAGE),
      offset: String(offset),
    });
    if (reason) params.set("reason", reason);
    if (query) params.set("q", query);
    let cancelled = false;
    api
      .get<FilesPage>(`/api/tools/transcode/files?${params}`)
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [filter, reason, query, sort, offset, refreshKey]);

  return (
    <div className="files">
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id && !reason}
              className={filter === f.id ? "tab active" : "tab"}
              onClick={() => onFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search file names"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as FileSort)}
          aria-label="Sort"
        >
          <option value="saving">Biggest saving first</option>
          <option value="size">Biggest files first</option>
          <option value="path">By name</option>
        </select>
      </div>
      {reason && <p className="muted small">Showing only: {reason}</p>}
      {error && <p className="bad">{error}</p>}
      {page && page.files.length === 0 && <p className="muted">Nothing here.</p>}
      {page && page.files.length > 0 && (
        <>
          <ul className="file-list">
            {page.files.map((file) => (
              <li key={file.id} className="file">
                <FileRow
                  file={file}
                  open={open === file.id}
                  onToggle={() => setOpen(open === file.id ? null : file.id)}
                />
                {open === file.id && <FileDetailView id={file.id} />}
              </li>
            ))}
          </ul>
          <div className="pager">
            <button
              type="button"
              className="small"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </button>
            <span className="muted">
              {count(offset + 1)}–{count(offset + page.files.length)} of {count(page.total)}
            </span>
            <button
              type="button"
              className="small"
              disabled={offset + PAGE >= page.total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function videoLabel(f: FileSummary): string {
  if (!f.videoCodec) return "";
  const codec =
    { h264: "H.264", hevc: "H.265", av1: "AV1", vp9: "VP9" }[f.videoCodec] ?? f.videoCodec;
  const size = f.width && f.height ? ` ${f.width}×${f.height}` : "";
  const rate = f.videoKbps !== null ? ` · ${(f.videoKbps / 1000).toFixed(1)} Mb/s` : "";
  return `${codec}${size}${rate}`;
}

function FileRow({
  file,
  open,
  onToggle,
}: {
  file: FileSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const name = file.path.split("/").pop() ?? file.path;
  const folder = file.path.slice(0, Math.max(0, file.path.length - name.length - 1));
  return (
    <button type="button" className="file-row link" aria-expanded={open} onClick={onToggle}>
      <span className="file-name">
        <strong>{name}</strong>
        <span className="muted small">{folder}</span>
      </span>
      <span className="muted small">{videoLabel(file)}</span>
      <span className="file-size">
        {bytes(file.sizeBytes)}
        {file.decision === "transcode" && file.estimatedBytes !== null && (
          <span className="good"> → {bytes(file.estimatedBytes)}</span>
        )}
      </span>
      <span className="muted small file-reason">{file.reason}</span>
    </button>
  );
}

const ACTION_LABEL: Record<PlannedTrack["action"], string> = {
  keep: "Keep",
  convert: "Convert",
  drop: "Drop",
};

function FileDetailView({ id }: { id: number }) {
  const { data: file, error } = useApi<FileDetail>(`/api/tools/transcode/files/${id}`);
  if (error) return <p className="bad">{error}</p>;
  if (!file) return <p className="muted">Loading…</p>;
  const plan = file.plan;
  return (
    <div className="file-detail">
      <p className="small muted">
        {file.root}/{file.path}
      </p>
      {file.arr && (
        <p className="small">
          {file.arr.app === "sonarr" ? "Sonarr" : "Radarr"}: <strong>{file.arr.title}</strong> ·
          original language {file.arr.originalLanguage ?? "unknown"}
        </p>
      )}
      {file.probeError && <p className="bad">Couldn't read the file: {file.probeError}</p>}
      <p>
        <strong>
          {file.decision === "transcode"
            ? "Would transcode"
            : file.decision === "skip"
              ? "Skipped"
              : "Problem"}
          :
        </strong>{" "}
        {file.reason}
      </p>
      {plan && (
        <>
          <p className="small">
            Video: {plan.video.from} → <strong>{plan.video.to}</strong>
          </p>
          <table className="tracks">
            <tbody>
              {plan.tracks.map((t) => (
                <tr key={`${t.kind}-${t.index}`} className={t.action}>
                  <td className="muted">
                    {t.kind === "audio"
                      ? "Audio"
                      : t.kind === "subtitle"
                        ? "Subtitle"
                        : "Attachment"}
                  </td>
                  <td>
                    {t.summary}
                    {t.makeDefault && <span className="badge">DEFAULT</span>}
                  </td>
                  <td>
                    <span className={`action ${t.action}`}>{ACTION_LABEL[t.action]}</span>
                    {t.to && <span className="small"> → {t.to}</span>}
                    {t.setLanguage && (
                      <span className="small muted"> · tagged “{t.setLanguage}”</span>
                    )}
                  </td>
                  <td className="muted small">{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.notes.length > 0 && (
            <ul className="notes">
              {plan.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <p className="small muted">
            Estimated result: {bytes(plan.estimatedBytes)} (from {bytes(file.sizeBytes)}). The real
            size is checked after encoding.
          </p>
        </>
      )}
    </div>
  );
}
