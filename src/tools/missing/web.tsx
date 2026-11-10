import { useState } from "react";
import { api } from "../../web/api.js";
import { Card, JobList } from "../../web/components.js";
import { ago, duration } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import { Link } from "../../web/router.js";
import type { MissingRun, MissingStatus } from "./shared.js";

const runFinished = (event: { type: string; job?: { tool: string; state: string } }) =>
  (event.type === "job.updated" &&
    event.job?.tool === "missing" &&
    event.job.state !== "queued" &&
    event.job.state !== "running") ||
  event.type === "settings.changed";

const APP = { sonarr: "Sonarr", radarr: "Radarr" } as const;

function every(hours: number): string {
  if (hours === 24) return "once a day";
  if (hours === 168) return "once a week";
  return hours % 24 === 0 ? `every ${hours / 24} days` : `every ${hours} hours`;
}

const inFuture = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  return ms <= 0 ? "within 10 minutes" : `in ${duration(ms)}`;
};

export function MissingPage() {
  const { data: s } = useApi<MissingStatus>("/api/tools/missing/status", runFinished);
  const { data: runs } = useApi<MissingRun[]>("/api/tools/missing/runs?limit=20", runFinished);
  const [message, setMessage] = useState<string | null>(null);

  const searchNow = async () => {
    setMessage(null);
    try {
      await api.post("/api/tools/missing/search");
      setMessage("Searching…");
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Missing</h1>
        <button type="button" className="primary" onClick={() => void searchNow()}>
          Search now
        </button>
      </div>
      <p className="muted">
        Sonarr and Radarr search for a missing episode or movie once, then only watch for new
        releases, so one that was already out and got missed is never found. Kondo asks them to
        search again for a few missing items at a time, the ones searched longest ago first.
      </p>
      {message && <p className="muted small">{message}</p>}

      {s && (
        <Card title="Status" actions={<Link to="/settings">Settings</Link>}>
          {!s.enabled ? (
            <p>Switched off. Turn it on in Settings → Missing search.</p>
          ) : (
            <>
              <p>
                Searches for up to <strong>{s.perRun}</strong> missing items in each of Sonarr and
                Radarr, <strong>{every(s.everyHours)}</strong>.
                {s.upgrades &&
                  " Files Sonarr/Radarr would replace (e.g. a dub their profile penalises) take turns with them."}
              </p>
              <p className="muted small">
                {s.lastRunAt ? `Last run ${ago(s.lastRunAt)}. ` : "Not run yet. "}
                {s.nextRunAt && `Next run ${inFuture(s.nextRunAt)}.`}
              </p>
            </>
          )}
        </Card>
      )}

      <h2>Recent runs</h2>
      {runs && runs.length === 0 && <p className="muted">None so far.</p>}
      {runs && runs.length > 0 && (
        <div className="card history">
          <ul className="log-entries">
            {runs.map((r) => (
              <li key={r.id}>
                <div className="log-line">
                  <span className="muted small">{ago(r.at)}</span>
                  <span className="log-name">
                    <strong>{APP[r.app]}</strong>
                  </span>
                  <span className="muted small">
                    {r.error
                      ? "failed"
                      : `${r.missing} missing${r.upgrades > 0 ? `, ${r.upgrades} to replace` : ""}, searched ${r.searched.length}`}
                  </span>
                </div>
                <p className="muted small log-detail">
                  {r.error ?? (r.searched.join(", ") || "Nothing to search for.")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Recent jobs</h2>
      <JobList tool="missing" limit={5} empty="Nothing yet." />
    </>
  );
}
