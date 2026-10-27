import { useEffect, useState } from "react";
import { api } from "../../web/api.js";
import { Card, JobList } from "../../web/components.js";
import { ago, bytes, count, duration } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import {
  type ApprovalItem,
  type FileDetail,
  type FileFilter,
  type FileSort,
  type FileSummary,
  type FilesPage,
  type HistoryItem,
  type LibrarySummary,
  OUTCOME_LABELS,
  type PlannedTrack,
  type SquishItem,
  type SquishSummary,
  type SquishTitle,
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
        Encoded results replace the originals once approved: by you, or automatically if Settings →
        Transcode says so.
      </p>

      {error && <p className="bad">{error}</p>}
      <Approvals />
      <RecentlyReplaced />
      {summary && <Summary summary={summary} onPick={pick} />}

      <h2>Recent work</h2>
      <JobList tool="transcode" limit={5} empty="Nothing yet." />

      <SquishTidy />

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

const encodeFinished = (event: {
  type: string;
  job?: { tool: string; type: string; state: string };
}) =>
  event.type === "job.updated" &&
  event.job?.tool === "transcode" &&
  (event.job.type === "encode" || event.job.type === "swap") &&
  event.job.state !== "queued";

function Approvals() {
  const { data, reload } = useApi<ApprovalItem[]>("/api/tools/transcode/approvals", encodeFinished);
  if (!data || data.length === 0) return null;
  const waiting = data.filter((i) => i.outcome.status === "awaiting-approval").length;
  return (
    <section>
      <h2>Waiting for your approval ({waiting})</h2>
      <div className="approvals">
        {data.map((item) => (
          <ApprovalCard key={item.file.id} item={item} onChanged={() => void reload()} />
        ))}
      </div>
    </section>
  );
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Original and Kondo's frame side by side, at each saved time. */
function Frames({ fileId, times }: { fileId: number; times: number[] }) {
  const frame = (kind: "source" | "output", i: number) =>
    `/api/tools/transcode/work/${fileId}/frame-${kind}-${i}.jpg`;
  return (
    <div className="frames">
      {times.map((at, i) => (
        <figure key={at}>
          <div className="pair">
            <a href={frame("source", i)} target="_blank" rel="noreferrer">
              <img src={frame("source", i)} alt={`Original at ${clock(at)}`} loading="lazy" />
            </a>
            <a href={frame("output", i)} target="_blank" rel="noreferrer">
              <img
                src={frame("output", i)}
                alt={`Kondo's version at ${clock(at)}`}
                loading="lazy"
              />
            </a>
          </div>
          <figcaption className="muted small">
            Original (left) and Kondo (right) at {clock(at)}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

const swapFinished = (event: {
  type: string;
  job?: { tool: string; type: string; state: string };
}) =>
  event.type === "job.updated" &&
  event.job?.tool === "transcode" &&
  event.job.type === "swap" &&
  event.job.state === "succeeded";

const squishJobChanged = (event: {
  type: string;
  job?: { tool: string; type: string; state: string };
}) =>
  event.type === "job.updated" &&
  event.job?.tool === "transcode" &&
  event.job.type.startsWith("squish-");

/** The one-off rename of Squish's `… [SQUISH].mkv` files back to their plain names. */
function SquishTidy() {
  const { data: s } = useApi<SquishSummary>("/api/tools/transcode/squish", squishJobChanged);
  const [error, setError] = useState<string | null>(null);
  if (!s) return null;
  // All done: nothing more to show (a few clashes may remain, listed for the record).
  if (s.checkedAt && s.pending === 0) return null;

  const post = async (url: string, body?: unknown) => {
    setError(null);
    try {
      await api.post(url, body);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <h2>Tidy [SQUISH] names</h2>
      <div className="card squish">
        <p>
          Squish added <code>[SQUISH]</code> to the names of files it encoded. Renaming them back
          lets Bazarr's subtitles match again. Kondo only renames: contents never change. Each title
          is renamed in one go, then Sonarr/Radarr and Plex are asked to rescan it.
        </p>
        {s.checkedAt ? (
          <p>
            <strong>{count(s.pending)}</strong> file(s) in {count(s.titles.length)} title(s) to
            rename
            {s.clashes > 0 && (
              <>
                ; <span className="warn">{count(s.clashes)} left alone</span> because the plain name
                is already taken
              </>
            )}
            {s.done > 0 && <> · {count(s.done)} done</>}.{" "}
            <span className="muted small">Checked {ago(s.checkedAt)}.</span>
          </p>
        ) : (
          <p className="muted">Not checked yet.</p>
        )}
        <div className="form-actions">
          {s.pending > 0 && (
            <button
              type="button"
              className="primary"
              onClick={() => void post("/api/tools/transcode/squish/rename", {})}
            >
              Rename all
            </button>
          )}
          <button type="button" onClick={() => void post("/api/tools/transcode/squish/check")}>
            {s.checkedAt ? "Check again" : "Check the library"}
          </button>
          {error && <span className="bad">{error}</span>}
        </div>
        {s.titles.length > 0 && (
          <div className="squish-titles">
            {s.titles.map((t) => (
              <SquishTitleRow
                key={t.key}
                title={t}
                onRename={() => void post("/api/tools/transcode/squish/rename", { title: t.key })}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SquishTitleRow({ title: t, onRename }: { title: SquishTitle; onRename: () => void }) {
  const [items, setItems] = useState<SquishItem[] | null>(null);
  const load = () => {
    if (!items) {
      void api
        .get<SquishItem[]>(`/api/tools/transcode/squish/items?title=${encodeURIComponent(t.key)}`)
        .then(setItems);
    }
  };
  return (
    <details onToggle={(e) => (e.currentTarget.open ? load() : undefined)}>
      <summary>
        <strong>{t.name}</strong>
        <span className="muted small">
          {count(t.pending)} to rename
          {t.clashes > 0 && <span className="warn"> · {t.clashes} left alone</span>}
        </span>
      </summary>
      {t.pending > 0 && (
        <button type="button" className="small" onClick={onRename}>
          Rename this title
        </button>
      )}
      {items ? (
        <ul className="squish-items small">
          {items.map((item) => (
            <li key={item.path} className={item.status}>
              <span>{item.path}</span>
              <span className="muted">
                {" "}
                → {item.target}
                {item.status !== "pending" && ` (${SQUISH_STATUS[item.status]})`}
                {item.error && `: ${item.error}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Loading…</p>
      )}
    </details>
  );
}

const SQUISH_STATUS: Record<SquishItem["status"], string> = {
  pending: "to do",
  clash: "name taken, left alone",
  done: "renamed",
  gone: "file gone",
  error: "failed",
};

function RecentlyReplaced() {
  const { data } = useApi<HistoryItem[]>("/api/tools/transcode/history?limit=20", swapFinished);
  if (!data || data.length === 0) return null;
  return (
    <section>
      <h2>Recently replaced</h2>
      <div className="card history">
        {data.map((item) => {
          const parts = item.path.split("/");
          const name = parts.pop() ?? item.path;
          return (
            <details key={`${item.fileId}-${item.swappedAt}`}>
              <summary>
                <span className="history-name">
                  <strong>{name}</strong>
                  <span className="muted small"> {parts.slice(-2).join("/")}</span>
                </span>
                <span className="small">
                  {bytes(item.sourceBytes)} → {bytes(item.outputBytes)}{" "}
                  <span className="muted">· {ago(item.swappedAt)}</span>
                </span>
              </summary>
              {item.details && item.details.frames.length > 0 ? (
                <Frames fileId={item.fileId} times={item.details.frames} />
              ) : (
                <p className="muted small">No comparison frames kept for this one.</p>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}

function ApprovalCard({ item, onChanged }: { item: ApprovalItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = item.outcome.details;
  const name = item.file.path.split("/").pop() ?? item.file.path;

  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/tools/transcode/approvals/${item.file.id}/${action}`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card approval">
      <header className="approval-head">
        <strong>{name}</strong>
        <span className="muted small">{item.file.path.slice(0, -name.length - 1)}</span>
      </header>
      {d && (
        <>
          <p className="approval-size">
            {bytes(d.sourceBytes)} → <strong>{bytes(d.outputBytes)}</strong>{" "}
            <span className="good">{d.savingPercent}% smaller</span>
          </p>
          <p className="muted small">
            {d.encoder}
            {d.averageFps !== null && ` · ${d.averageFps} fps`} · took{" "}
            {duration(d.encodeSeconds * 1000)}
            {d.crop && ` · black bars cropped (${d.crop})`}
          </p>
          <p className="small">
            ✓ Same length · ✓ {d.verify.audio.found} audio and {d.verify.subtitles.found} subtitle
            track(s) as planned · ✓ Plays cleanly
          </p>
          <p className="small watch">
            Watch:{" "}
            <a
              href={`/api/tools/transcode/files/${item.file.id}/original`}
              target="_blank"
              rel="noreferrer"
            >
              original
            </a>{" "}
            ·{" "}
            <a
              href={`/api/tools/transcode/work/${item.file.id}/output.mkv`}
              target="_blank"
              rel="noreferrer"
            >
              Kondo's version
            </a>{" "}
            <span className="muted">
              — browsers often can't play these; copy the link into VLC (Media → Open Network
              Stream).
            </span>
          </p>
          <Frames fileId={item.file.id} times={d.frames} />
        </>
      )}
      {item.outcome.status === "swapping" ? (
        <p className="good">Swapping into the library…</p>
      ) : item.outcome.status === "approved" ? (
        <p className="good">Approved. It replaces the original as soon as nobody is watching it.</p>
      ) : (
        <div className="form-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act("approve")}
          >
            Approve
          </button>
          <button type="button" disabled={busy} onClick={() => void act("reject")}>
            Reject
          </button>
          <button type="button" className="link small" onClick={() => setShowPlan(!showPlan)}>
            {showPlan ? "Hide tracks" : "Show tracks"}
          </button>
          {error && <span className="bad">{error}</span>}
        </div>
      )}
      {item.outcome.status === "awaiting-approval" && item.outcome.error && (
        <p className="bad small">{item.outcome.error}</p>
      )}
      {showPlan && <FileDetailView id={item.file.id} />}
    </article>
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
        {s.done.count > 0 && (
          <div className="tile">
            <span className="tile-label">Done</span>
            <strong className="good">{bytes(s.done.savedBytes)} saved</strong>
            <span className="muted">{count(s.done.count)} file(s) replaced</span>
          </div>
        )}
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
      <span className="muted small file-reason">
        {file.outcomeStatus && (
          <span className={`pill outcome ${file.outcomeStatus}`}>
            {OUTCOME_LABELS[file.outcomeStatus]}
          </span>
        )}{" "}
        {file.reason}
      </span>
    </button>
  );
}

const ACTION_LABEL: Record<PlannedTrack["action"], string> = {
  keep: "Keep",
  convert: "Convert",
  drop: "Drop",
};

function FileDetailView({ id }: { id: number }) {
  const {
    data: file,
    error,
    reload,
  } = useApi<FileDetail>(
    `/api/tools/transcode/files/${id}`,
    (event) =>
      event.type === "job.updated" && event.job.tool === "transcode" && event.job.type === "encode",
  );
  const [message, setMessage] = useState<string | null>(null);
  const encodeNow = async () => {
    setMessage(null);
    try {
      await api.post(`/api/tools/transcode/files/${id}/encode`);
      setMessage("Queued. It starts straight away unless Plex needs the GPU.");
      void reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
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
      {file.outcome && (
        <p className="small">
          Result: <strong>{OUTCOME_LABELS[file.outcome.status]}</strong>
          {file.outcome.error && ` — ${file.outcome.error}`}
        </p>
      )}
      {file.encoding && <p className="small">Encoding is queued or running (see Recent work).</p>}
      {file.decision === "transcode" &&
        !file.encoding &&
        (!file.outcome || file.outcome.status === "failed") && (
          <div className="form-actions">
            <button type="button" className="small" onClick={() => void encodeNow()}>
              Encode now
            </button>
            {message && <span className="muted small">{message}</span>}
          </div>
        )}
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
