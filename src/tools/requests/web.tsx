import { useState } from "react";
import { api } from "../../web/api.js";
import { Card, JobList } from "../../web/components.js";
import { ago } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import { Link } from "../../web/router.js";
import type { Notice, RequestsStatus } from "./shared.js";

const checkFinished = (event: { type: string; job?: { tool: string; state: string } }) =>
  (event.type === "job.updated" &&
    event.job?.tool === "requests" &&
    event.job.state !== "queued" &&
    event.job.state !== "running") ||
  event.type === "settings.changed";

const LABEL: Record<Notice["status"], string> = {
  sent: "emailed",
  failed: "failed",
  skipped: "no email address",
  before: "already ready",
};

export function RequestsPage() {
  const { data: s } = useApi<RequestsStatus>("/api/tools/requests/status", checkFinished);
  const { data: notices } = useApi<Notice[]>("/api/tools/requests/notices?limit=30", checkFinished);
  const [message, setMessage] = useState<string | null>(null);

  const checkNow = async () => {
    setMessage(null);
    try {
      await api.post("/api/tools/requests/check");
      setMessage("Checking…");
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Request emails</h1>
        <button type="button" className="primary" onClick={() => void checkNow()}>
          Check now
        </button>
      </div>
      <p className="muted">
        Emails whoever requested a film or show in Seerr once they can start watching it: a film
        once it's in Plex, a show once episode 1 of the first season they asked for is. Seerr's own
        email waits until every requested season is complete.
      </p>
      {message && <p className="muted small">{message}</p>}

      {s && (
        <Card title="Status" actions={<Link to="/settings">Settings</Link>}>
          {!s.enabled ? (
            <p>Switched off. Turn it on in Settings → Request emails.</p>
          ) : s.missing.length > 0 ? (
            <p>Set up {s.missing.join(" and ")} in Settings first.</p>
          ) : (
            <>
              <p>
                Checks Seerr every 5 minutes. <strong>{s.waiting}</strong> request(s) aren't ready
                yet.
              </p>
              <p className="muted small">
                {s.checkedAt ? `Last checked ${ago(s.checkedAt)}.` : "Not checked yet."}
                {s.lastError && ` ${s.lastError}`}
              </p>
            </>
          )}
        </Card>
      )}

      <h2>Recent emails</h2>
      {notices && notices.length === 0 && <p className="muted">None so far.</p>}
      {notices && notices.length > 0 && (
        <div className="card history">
          <ul className="log-entries">
            {notices.map((n) => (
              <li key={n.requestId}>
                <div className="log-line">
                  <span className="muted small">{ago(n.at)}</span>
                  <span className="log-name">
                    <strong>{n.title}</strong>
                  </span>
                  <span className="muted small">
                    {n.user} · {LABEL[n.status]}
                  </span>
                </div>
                {(n.detail || n.error) && (
                  <p className="muted small log-detail">
                    {[n.detail, n.error && `${n.error} (try ${n.attempts})`]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Recent jobs</h2>
      <JobList tool="requests" limit={5} empty="Nothing yet." />
    </>
  );
}
