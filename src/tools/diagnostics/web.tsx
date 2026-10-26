import { useState } from "react";
import { api } from "../../web/api.js";
import { Card, JobList } from "../../web/components.js";
import { ago } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import type { EncoderReport, StartTestBody } from "./shared.js";

function Yes({ ok }: { ok: boolean }) {
  return <span className={ok ? "good" : "bad"}>{ok ? "Ready" : "Missing"}</span>;
}

export function DiagnosticsPage() {
  const { data: report, error, reload } = useApi<EncoderReport>("/api/tools/diagnostics/encoders");
  const [force, setForce] = useState(true);
  const [seconds, setSeconds] = useState(20);
  const [message, setMessage] = useState<string | null>(null);

  const start = async (slot: StartTestBody["slot"]) => {
    setMessage(null);
    try {
      await api.post("/api/tools/diagnostics/test", {
        slot,
        seconds,
        force,
      } satisfies StartTestBody);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <>
      <h1>Diagnostics</h1>
      <div className="grid">
        <Card
          title="Encoders"
          actions={
            <button
              type="button"
              className="small"
              onClick={() => void api.get("/api/tools/diagnostics/encoders?refresh=1").then(reload)}
            >
              Check again
            </button>
          }
        >
          {error && <p className="bad">{error}</p>}
          {report && (
            <dl>
              <dt>ffmpeg</dt>
              <dd>
                {report.ffmpeg.found ? (
                  report.ffmpeg.version
                ) : (
                  <span className="bad">{report.ffmpeg.error}</span>
                )}
              </dd>
              <dt>GPU</dt>
              <dd>
                {report.gpu ? `${report.gpu.name} (driver ${report.gpu.driver})` : "None found"}
              </dd>
              <dt>H.265 on GPU</dt>
              <dd>
                <Yes ok={report.encoders.hevc_nvenc} /> <span className="muted">hevc_nvenc</span>
              </dd>
              <dt>H.265 on CPU</dt>
              <dd>
                <Yes ok={report.encoders.libx265} /> <span className="muted">libx265</span>
              </dd>
              <dt>E-AC3 audio</dt>
              <dd>
                <Yes ok={report.encoders.eac3} /> <span className="muted">eac3</span>
              </dd>
              <dt>Checked</dt>
              <dd className="muted">{ago(report.checkedAt)}</dd>
            </dl>
          )}
        </Card>

        <Card title="Test encode">
          <p className="muted">
            Encodes a generated 1080p test pattern and throws the result away. It goes through the
            real job queue, so it shows the slots, live progress and pausing working.
          </p>
          <div className="field checkbox">
            <label>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Run now, outside the night window
            </label>
            <span className="muted">It still pauses if Plex needs the same hardware.</span>
          </div>
          <div className="field">
            <label htmlFor="test-seconds">Seconds of video</label>
            <input
              id="test-seconds"
              type="number"
              min={5}
              max={600}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
          </div>
          <div className="form-actions">
            <button type="button" className="primary" onClick={() => void start("gpu")}>
              Test GPU
            </button>
            <button type="button" className="primary" onClick={() => void start("cpu")}>
              Test CPU
            </button>
            {message && <span className="bad">{message}</span>}
          </div>
        </Card>
      </div>

      <h2>Recent tests</h2>
      <JobList tool="diagnostics" limit={20} empty="No tests run yet." />
    </>
  );
}
