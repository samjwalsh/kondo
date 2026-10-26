import { type ReactNode, useState } from "react";
import type { HealthStatus, Job, JobDetail, JobLogLine } from "../shared/api.js";
import { api } from "./api.js";
import { ago, duration, percent } from "./format.js";
import { useApi, useLiveEvents } from "./live.js";

export function Dot({ status }: { status: HealthStatus }) {
  const label = { ok: "OK", warn: "Needs attention", error: "Problem" }[status];
  return <span className={`dot ${status}`} role="img" aria-label={label} title={label} />;
}

export function Card({
  title,
  children,
  actions,
}: {
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Progress({ value, paused = false }: { value: number | null; paused?: boolean }) {
  return (
    <div
      className={`progress${value === null ? " indeterminate" : ""}${paused ? " paused" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <div style={{ width: value === null ? undefined : `${value * 100}%` }} />
    </div>
  );
}

const STATE_LABEL: Record<Job["state"], string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatePill({ state }: { state: Job["state"] }) {
  return <span className={`pill ${state}`}>{STATE_LABEL[state]}</span>;
}

/** One line under a job: progress while active, timing once finished. */
export function JobSummary({ job }: { job: Job }) {
  if (job.state === "running" || job.state === "paused") {
    return (
      <div className="job-progress">
        <Progress value={job.progress} paused={job.state === "paused"} />
        <span className="muted">
          {[percent(job.progress), job.progressText].filter(Boolean).join(" · ")}
        </span>
      </div>
    );
  }
  if (job.state === "queued") return <span className="muted">Queued {ago(job.createdAt)}</span>;
  const took =
    job.startedAt && job.finishedAt
      ? ` in ${duration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}`
      : "";
  return (
    <span className={job.state === "failed" ? "bad" : "muted"}>
      {job.state === "failed" ? job.error : `${STATE_LABEL[job.state]}${took}`} ·{" "}
      {ago(job.finishedAt)}
    </span>
  );
}

/** A live list of jobs (optionally one tool's), patched in place as events arrive. */
export function JobList({
  tool,
  limit = 50,
  empty,
}: {
  tool?: string;
  limit?: number;
  empty?: string;
}) {
  const query = `/api/jobs?limit=${limit}${tool ? `&tool=${encodeURIComponent(tool)}` : ""}`;
  const { data, error, setData } = useApi<Job[]>(query);
  const [open, setOpen] = useState<number | null>(null);

  useLiveEvents((event) => {
    if (event.type !== "job.updated" || (tool && event.job.tool !== tool)) return;
    setData((jobs) => {
      if (!jobs) return jobs;
      const i = jobs.findIndex((j) => j.id === event.job.id);
      if (i === -1) return [event.job, ...jobs].slice(0, limit);
      const next = [...jobs];
      next[i] = event.job;
      return next;
    });
  });

  if (error) return <p className="bad">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (data.length === 0) return <p className="muted">{empty ?? "No jobs yet."}</p>;

  return (
    <ul className="jobs">
      {data.map((job) => (
        <li key={job.id} className="job">
          <div className="job-row">
            <button
              type="button"
              className="job-title link"
              onClick={() => setOpen(open === job.id ? null : job.id)}
            >
              <span className="muted">#{job.id}</span> {job.title}
            </button>
            <span className="badge">{job.slot.toUpperCase()}</span>
            <StatePill state={job.state} />
            <JobActions job={job} />
          </div>
          <JobSummary job={job} />
          {open === job.id && <JobLogs id={job.id} />}
        </li>
      ))}
    </ul>
  );
}

function JobActions({ job }: { job: Job }) {
  const [busy, setBusy] = useState(false);
  const act = async (action: "cancel" | "retry") => {
    setBusy(true);
    try {
      await api.post(`/api/jobs/${job.id}/${action}`);
    } finally {
      setBusy(false);
    }
  };
  if (job.state === "queued" || job.state === "running" || job.state === "paused") {
    return (
      <button type="button" className="small" disabled={busy} onClick={() => act("cancel")}>
        Cancel
      </button>
    );
  }
  if (job.state === "failed" || job.state === "cancelled") {
    return (
      <button type="button" className="small" disabled={busy} onClick={() => act("retry")}>
        Retry
      </button>
    );
  }
  return null;
}

function JobLogs({ id }: { id: number }) {
  const { data, setData } = useApi<JobDetail>(`/api/jobs/${id}`);
  useLiveEvents((event) => {
    if (event.type === "job.log" && event.jobId === id) {
      setData((job) => (job ? { ...job, logs: [...job.logs, event.line] } : job));
    }
  });
  if (!data) return <p className="muted">Loading log…</p>;
  return (
    <ol className="log">
      {data.logs.map((line: JobLogLine, i) => (
        // Log lines never reorder, so the index is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <li key={i} className={line.level}>
          <time>{new Date(line.ts).toLocaleTimeString()}</time> {line.message}
        </li>
      ))}
    </ol>
  );
}
