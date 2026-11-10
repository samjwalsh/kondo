import { useState } from "react";
import { api } from "../../web/api.js";
import { Card, JobList } from "../../web/components.js";
import { ago, count } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import { Link } from "../../web/router.js";
import type { DownloadsStatus, FakeEntry } from "./shared.js";

const checkFinished = (event: { type: string; job?: { tool: string; state: string } }) =>
  (event.type === "job.updated" &&
    event.job?.tool === "downloads" &&
    event.job.state !== "queued" &&
    event.job.state !== "running") ||
  event.type === "settings.changed";

const MODE: Record<DownloadsStatus["mode"], string> = {
  off: "Off",
  report: "Report only: listed, nothing is changed",
  remove: "Remove: blocklisted in Sonarr/Radarr (which search again) and deleted",
};

const ACTION: Record<FakeEntry["action"], string> = {
  found: "Found",
  removed: "Removed",
  error: "Couldn't remove",
};

export function DownloadsPage() {
  const { data: s } = useApi<DownloadsStatus>("/api/tools/downloads/status", checkFinished);
  const { data: log } = useApi<FakeEntry[]>("/api/tools/downloads/log?limit=100", checkFinished);
  const [message, setMessage] = useState<string | null>(null);

  const checkNow = async () => {
    setMessage(null);
    try {
      await api.post("/api/tools/downloads/check");
      setMessage("Checking…");
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Downloads</h1>
        <button type="button" className="primary" onClick={() => void checkNow()}>
          Check now
        </button>
      </div>
      <p className="muted">
        Fake releases carry a program (e.g. “Episode.exe”) instead of the video; stuck downloads
        never get their file list or stop getting further (often a fake swarm with no real seed).
        Sonarr and Radarr don't search again in either case, so the episode stays missing. Kondo
        checks each of their downloads in qBittorrent to find them.
      </p>
      {message && <p className="muted small">{message}</p>}

      {s && (
        <Card title="Status" actions={<Link to="/settings">Settings</Link>}>
          {!s.configured ? (
            <p className="warn">Set up qBittorrent in Settings first.</p>
          ) : (
            <>
              <p>
                Fakes: <strong>{MODE[s.mode]}</strong>
              </p>
              <p>
                Stuck: <strong>{MODE[s.stuckMode]}</strong>
              </p>
              <p className="muted small">
                {s.lastCheck
                  ? s.lastCheck.error
                    ? `Last check failed ${ago(s.lastCheck.at)}: ${s.lastCheck.error}`
                    : `Last checked ${ago(s.lastCheck.at)}: ${count(s.lastCheck.torrents)} downloads`
                  : "Not checked yet."}
              </p>
              {s.waiting.fakes + s.waiting.stuck > 0 && (
                <p className="warn">
                  {[
                    s.waiting.fakes > 0 ? `${s.waiting.fakes} fake` : null,
                    s.waiting.stuck > 0 ? `${s.waiting.stuck} stuck` : null,
                  ]
                    .filter(Boolean)
                    .join(" and ")}{" "}
                  download(s) still in qBittorrent: listed below. To clear them, set Remove in
                  Settings → Downloads.
                </p>
              )}
            </>
          )}
        </Card>
      )}

      <h2>Bad downloads found</h2>
      {log && log.length === 0 && <p className="muted">None so far.</p>}
      {log && log.length > 0 && (
        <div className="card history">
          <ul className="log-entries">
            {log.map((e) => (
              <li key={e.id}>
                <div className="log-line">
                  <span className="muted small">{ago(e.at)}</span>
                  <span className={`pill fake ${e.action}`}>{ACTION[e.action]}</span>
                  <span className="pill">{e.kind === "stuck" ? "Stuck" : "Fake"}</span>
                  <span className="log-name">
                    <strong>{e.what ?? e.name}</strong>
                    {e.what && <span className="muted small"> {e.name}</span>}
                  </span>
                  <span className="muted small">
                    {[
                      e.app === "sonarr" ? "Sonarr" : e.app === "radarr" ? "Radarr" : null,
                      e.indexer,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <p className="muted small log-detail">
                  {e.problem ?? `Contains ${e.badFiles.join(", ")}`}
                  {e.detail && `. ${e.detail}`}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Recent checks</h2>
      <JobList tool="downloads" limit={5} empty="Nothing yet." />
    </>
  );
}
