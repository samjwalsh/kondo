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

interface Cell {
  ip: string;
  last: number;
  taken: TakenIp | null;
}

/** Every address in the scanned range, in order. */
function cells(scan: IpScan): Cell[] {
  const prefix = scan.from.split(".").slice(0, 3).join(".");
  const from = Number(scan.from.split(".")[3]);
  const to = Number(scan.to.split(".")[3]);
  const taken = new Map(scan.taken.map((t) => [t.ip, t]));
  const out: Cell[] = [];
  for (let n = from; n <= to; n++) {
    const ip = `${prefix}.${n}`;
    out.push({ ip, last: n, taken: taken.get(ip) ?? null });
  }
  return out;
}

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

  const all = scan && !scan.error ? cells(scan) : [];
  const shown = all.find((c) => c.ip === (picked ?? scan?.firstFree)) ?? null;

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
      {scan?.error && <p className="bad">{scan.error}</p>}

      {scan && !scan.error && (
        <Card title="Addresses" actions={<Link to="/settings">Settings</Link>}>
          <p className="muted small">
            {scan.freeCount} free between {scan.from} and {scan.to}
            {scan.firstFree ? `, lowest ${scan.firstFree}` : ""}. Scanned {ago(scan.scannedAt)}.
            Click a free address to copy it.
          </p>
          <div className="ip-grid">
            {all.map((c) => (
              <button
                type="button"
                key={c.ip}
                className={[
                  "ip-cell",
                  c.taken ? "taken" : "free",
                  c.ip === scan.firstFree ? "lowest" : "",
                  c.ip === shown?.ip ? "picked" : "",
                ].join(" ")}
                title={`${c.ip}: ${c.taken ? BY[c.taken.by] : "free"}`}
                onClick={() => {
                  setPicked(c.ip);
                  if (!c.taken) copy(c.ip);
                }}
              >
                {c.last}
              </button>
            ))}
          </div>
          <div className="ip-legend muted small">
            <span>
              <i className="ip-cell free" /> free
            </span>
            <span>
              <i className="ip-cell taken" /> taken
            </span>
            <span>
              <i className="ip-cell free lowest" /> lowest free
            </span>
          </div>
          {shown && (
            <p className="ip-detail">
              <strong>{shown.ip}</strong>{" "}
              {shown.taken ? (
                <span className="muted">
                  taken: {BY[shown.taken.by]}
                  {shown.taken.mac ? ` · ${shown.taken.mac}` : ""}
                </span>
              ) : (
                <span className="good">{copied === shown.ip ? "free · copied" : "free"}</span>
              )}
            </p>
          )}
        </Card>
      )}
    </>
  );
}
