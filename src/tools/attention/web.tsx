import { useState } from "react";
import { api } from "../../web/api.js";
import { Card } from "../../web/components.js";
import { ago } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import { Link } from "../../web/router.js";
import type { AttentionItem, AttentionKind, AttentionStatus } from "./shared.js";

const KIND_LABELS: Record<AttentionKind, string> = {
  "not-found": "Never found",
  replace: "Waiting for a better copy",
  stalled: "Download not moving",
  import: "Stuck in the download queue",
  health: "Sonarr/Radarr warnings",
  service: "Not answering",
  unmatched: "Not matched in Plex",
  transcode: "Transcode gave up",
};

const checkFinished = (event: { type: string; job?: { tool: string; state: string } }) =>
  (event.type === "job.updated" &&
    event.job?.tool === "attention" &&
    event.job.state !== "queued" &&
    event.job.state !== "running") ||
  event.type === "settings.changed";

export function AttentionPage() {
  const { data: s } = useApi<AttentionStatus>("/api/tools/attention/status", checkFinished);
  const { data: all } = useApi<AttentionItem[]>("/api/tools/attention/items", checkFinished);
  const [message, setMessage] = useState<string | null>(null);
  const due = new Set(s?.due.map((i) => i.key));
  const kinds = Object.keys(KIND_LABELS) as AttentionKind[];

  const tryAgain = async (item: AttentionItem) => {
    setMessage(null);
    const fileId = item.key.split(":").pop();
    try {
      await api.post(`/api/tools/transcode/files/${fileId}/retry`);
      await api.post("/api/tools/attention/check");
      setMessage(`${item.what} will be encoded again in its turn.`);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const checkNow = async () => {
    setMessage(null);
    try {
      await api.post("/api/tools/attention/check");
      setMessage("Checking…");
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Needs a look</h1>
        <button type="button" className="primary" onClick={() => void checkNow()}>
          Check now
        </button>
      </div>
      <p className="muted">
        Things that don't fail loudly but never sort themselves out. Kondo checks every hour and
        reports only problems that have lasted (missing items and stuck downloads after{" "}
        {s?.stuckDays ?? 1} day(s), failed imports, warnings and items Plex couldn't match after{" "}
        {s?.stuckHours ?? 6} hours, files Transcode gave up on straight away), at the top of the
        morning summary.
      </p>
      {message && <p className="muted small">{message}</p>}
      {s && (
        <Card title="Status" actions={<Link to="/settings">Settings</Link>}>
          <p>
            {s.due.length === 0 ? "Nothing needs you." : `${s.due.length} thing(s) need a look.`}{" "}
            {s.watching > 0 && (
              <span className="muted">
                Watching {s.watching} more that may still sort themselves out.
              </span>
            )}
          </p>
          <p className="muted small">
            {s.checkedAt ? `Last checked ${ago(s.checkedAt)}.` : "Not checked yet."}
          </p>
          {s.errors.length > 0 && (
            <p className="bad small">Couldn't check: {s.errors.join("; ")}</p>
          )}
        </Card>
      )}
      {all &&
        kinds.map((kind) => {
          const items = all.filter((i) => i.kind === kind);
          if (items.length === 0) return null;
          return (
            <section key={kind}>
              <h2>
                {KIND_LABELS[kind]} ({items.length})
              </h2>
              <div className="card history">
                <ul className="log-entries">
                  {items.map((i) => (
                    <li key={i.key}>
                      <div className="log-line">
                        <span className="muted small">since {ago(i.firstSeen)}</span>
                        <span className="log-name">
                          <strong>{i.what}</strong>
                        </span>
                        <span className={due.has(i.key) ? "bad small" : "muted small"}>
                          {due.has(i.key) ? "needs a look" : "watching"}
                        </span>
                      </div>
                      {i.detail && <p className="muted small log-detail">{i.detail}</p>}
                      {i.kind === "transcode" && (
                        <button type="button" className="small" onClick={() => void tryAgain(i)}>
                          Try again
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          );
        })}
    </>
  );
}
