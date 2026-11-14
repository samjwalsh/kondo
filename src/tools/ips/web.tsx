import { useState } from "react";
import { api } from "../../web/api.js";
import { Card } from "../../web/components.js";
import { ago } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import { Link } from "../../web/router.js";
import type { IpScan } from "./shared.js";

/** A label short enough for a grid cell. */
const short = (label: string) => label.split(/[ ,.]/)[0]?.slice(0, 12) ?? label;

export function IpsPage() {
  const { data: scan, error, reload } = useApi<IpScan>("/api/tools/ips/scan");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const rescan = async () => {
    setBusy(true);
    try {
      await api.get("/api/tools/ips/scan?refresh=1");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const copy = (ip: string) => {
    void navigator.clipboard?.writeText(ip).then(() => {
      setCopied(ip);
      window.setTimeout(() => setCopied((c) => (c === ip ? null : c)), 1500);
    });
  };

  const all = scan?.addresses ?? [];
  const shown = all.find((a) => a.ip === (picked ?? scan?.firstFree)) ?? null;
  const stopped = all.filter((a) => a.state === "stopped").length;
  const clashes = all.filter((a) => a.clash);

  return (
    <>
      <div className="page-head">
        <h1>Free IPs</h1>
        <button type="button" className="primary" disabled={busy} onClick={() => void rescan()}>
          {busy ? "Scanning…" : "Scan again"}
        </button>
      </div>
      <p className="muted">
        Pings every address in the range and reads the ARP table, so devices that ignore ping still
        count. Containers' addresses come from Unraid, so stopped ones still hold theirs.
      </p>
      {error && <p className="bad">{error}</p>}
      {!scan && !error && <p className="muted">Scanning…</p>}
      {scan?.error && <p className="bad">{scan.error}</p>}
      {scan && !scan.docker.used && !scan.error && (
        <p className="warn">
          Unraid isn't set up, so stopped containers look free. Add it in{" "}
          <Link to="/settings">Settings → Unraid</Link>.
        </p>
      )}
      {scan?.docker.error && <p className="bad">{scan.docker.error}</p>}
      {clashes.length > 0 && (
        <p className="bad">
          {clashes.map((c) => `${c.ip}: ${c.why}`).join(". ")}. Starting it would clash.
        </p>
      )}

      {scan && !scan.error && (
        <Card title="Addresses" actions={<Link to="/settings">Settings</Link>}>
          <p className="muted small">
            {scan.freeCount} free between {scan.from} and {scan.to}
            {scan.firstFree ? `, lowest ${scan.firstFree}` : ""}
            {stopped > 0 ? `; ${stopped} held by stopped containers` : ""}. Scanned{" "}
            {ago(scan.scannedAt)}. Click a free address to copy it.
          </p>
          <div className="ip-grid">
            {all.map((a) => (
              <button
                type="button"
                key={a.ip}
                className={[
                  "ip-cell",
                  a.state,
                  a.clash ? "clash" : "",
                  a.ip === scan.firstFree ? "lowest" : "",
                  a.ip === shown?.ip ? "picked" : "",
                ].join(" ")}
                title={`${a.ip}${a.label ? ` ${a.label}` : ""}: ${a.why}`}
                onClick={() => {
                  setPicked(a.ip);
                  if (a.state === "free") copy(a.ip);
                }}
              >
                <span className="ip-num">{a.last}</span>
                {a.label && <span className="ip-label">{short(a.label)}</span>}
              </button>
            ))}
          </div>
          <div className="ip-legend muted small">
            <span>
              <i className="ip-cell free" /> free
            </span>
            <span>
              <i className="ip-cell stopped" /> stopped container
            </span>
            <span>
              <i className="ip-cell taken" /> in use
            </span>
          </div>
          {shown && (
            <p className="ip-detail">
              <strong>{shown.ip}</strong> {shown.label && <strong>{shown.label}</strong>}{" "}
              <span className={shown.state === "free" ? "good" : "muted"}>
                {shown.state === "free"
                  ? copied === shown.ip
                    ? "free · copied"
                    : "free"
                  : `${shown.why}${shown.mac ? ` · ${shown.mac}` : ""}`}
              </span>
            </p>
          )}
        </Card>
      )}
    </>
  );
}
