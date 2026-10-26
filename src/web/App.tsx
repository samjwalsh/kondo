import { useEffect, useState } from "react";
import type { HealthResponse } from "../shared/api.js";
import { api } from "./api.js";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const h = await api.health();
        if (cancelled) return;
        setHealth(h);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <main>
      <header>
        <h1>Kondo</h1>
        <p className="tagline">Keeps the media server tidy.</p>
      </header>

      <section className="card">
        <h2>Status</h2>
        {error && <p className="bad">Can't reach the server: {error}</p>}
        {!error && !health && <p className="muted">Checking…</p>}
        {health && (
          <dl>
            <dt>Server</dt>
            <dd className="good">Running</dd>
            <dt>Version</dt>
            <dd>{health.version}</dd>
            <dt>Up for</dt>
            <dd>{formatUptime(health.uptimeSeconds)}</dd>
            <dt>Node</dt>
            <dd>{health.node}</dd>
          </dl>
        )}
      </section>

      <section className="card">
        <h2>Tools</h2>
        <p className="muted">No tools yet. Transcode is next.</p>
      </section>
    </main>
  );
}
