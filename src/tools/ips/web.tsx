import { useState } from "react";
import { api } from "../../web/api.js";
import { Card } from "../../web/components.js";
import { ago } from "../../web/format.js";
import { useApi } from "../../web/live.js";
import { Link } from "../../web/router.js";
import type { IpScan, TakenIp } from "./shared.js";

const BY: Record<TakenIp["by"], string> = {
  reply: "answered ping",
  arp: "answered ARP only",
  "this machine": "Kondo's machine",
  reserved: "listed in Settings",
};

export function IpsPage() {
  const { data: scan, error, reload } = useApi<IpScan>("/api/tools/ips/scan");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

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
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

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
        count. Anything switched off (e.g. a stopped container) can't answer: add those under Also
        taken in Settings.
      </p>
      {error && <p className="bad">{error}</p>}
      {!scan && !error && <p className="muted">Scanning…</p>}

      {scan && (
        <Card title="Lowest free address" actions={<Link to="/settings">Settings</Link>}>
          {scan.error ? (
            <p className="bad">{scan.error}</p>
          ) : scan.firstFree ? (
            <>
              <p>
                <button type="button" className="ip-big" onClick={() => copy(scan.firstFree ?? "")}>
                  {scan.firstFree}
                </button>{" "}
                <span className="muted small">{copied ? "Copied" : "click to copy"}</span>
              </p>
              <p className="muted small">
                {scan.freeCount} free between {scan.from} and {scan.to}. Scanned{" "}
                {ago(scan.scannedAt)}.
              </p>
            </>
          ) : (
            <p className="bad">
              Nothing free between {scan.from} and {scan.to}.
            </p>
          )}
        </Card>
      )}

      {scan && scan.taken.length > 0 && (
        <>
          <h2>Taken ({scan.taken.length})</h2>
          <div className="card history">
            <ul className="log-entries">
              {scan.taken.map((t) => (
                <li key={t.ip}>
                  <div className="log-line">
                    <span className="log-name">
                      <strong>{t.ip}</strong>
                    </span>
                    <span className="muted small">
                      {BY[t.by]}
                      {t.mac ? ` · ${t.mac}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
