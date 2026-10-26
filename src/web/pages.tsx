import type { HealthCheck, SlotStatus, StatusResponse } from "../shared/api.js";
import type { SettingsResponse, SettingsSection } from "../shared/settings.js";
import { toolPages } from "../tools/web.js";
import { Card, Dot, JobList, JobSummary } from "./components.js";
import { ago } from "./format.js";
import { useApi } from "./live.js";
import { Link } from "./router.js";
import { SettingsForm, TimeZoneList } from "./SettingsForm.js";

const refreshStatus = (event: { type: string }) =>
  event.type === "status.changed" ||
  event.type === "job.updated" ||
  event.type === "settings.changed";

export function useStatus() {
  return useApi<StatusResponse>("/api/status", refreshStatus);
}

// Dashboard ------------------------------------------------------------------

export function Dashboard() {
  const { data: status, error } = useStatus();
  if (error) return <p className="bad">{error}</p>;
  if (!status) return <p className="muted">Loading…</p>;

  const problems = status.health.checks.filter((c) => c.status === "error");
  const warnings = status.health.checks.filter((c) => c.status === "warn");
  const encoders = status.slots.filter((s) => s.id !== "general" || s.jobs.length > 0);

  return (
    <>
      <div className={`banner ${status.health.overall}`}>
        <Dot status={status.health.overall} />
        {problems.length > 0
          ? `${problems.length} problem${problems.length > 1 ? "s" : ""} need${problems.length > 1 ? "" : "s"} attention`
          : warnings.length > 0
            ? `Running, with ${warnings.length} thing${warnings.length > 1 ? "s" : ""} to set up`
            : "All good"}
      </div>

      <div className="grid">
        <Card title="Encoders">
          {encoders.map((slot) => (
            <SlotView key={slot.id} slot={slot} />
          ))}
        </Card>

        <Card title="Plex">
          <PlexView status={status} />
        </Card>

        <Card title="Schedule" actions={<Link to="/settings">Change</Link>}>
          <dl>
            <dt>Time now</dt>
            <dd>
              {status.schedule.localTime}{" "}
              <span className="muted">({status.schedule.timeZone})</span>
            </dd>
            <dt>Night window</dt>
            <dd>
              {status.schedule.windowStart}–{status.schedule.windowEnd}
              {status.schedule.inWindow && <span className="good"> · open now</span>}
            </dd>
            <dt>Idle mode</dt>
            <dd>
              {status.schedule.idleMode
                ? `On — after ${status.schedule.idleQuietMinutes} quiet minutes`
                : "Off"}
            </dd>
          </dl>
        </Card>

        <Card title="Health">
          <ul className="checks">
            {status.health.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </ul>
        </Card>

        {status.tools.map((tool) => (
          <Card
            key={tool.id}
            title={
              <>
                {tool.card && <Dot status={tool.card.status} />} {tool.name}
              </>
            }
            actions={toolPages[tool.id] ? <Link to={`/tools/${tool.id}`}>Open</Link> : undefined}
          >
            {(tool.card?.lines ?? [tool.description]).map((line) => (
              <p key={line} className="tight">
                {line}
              </p>
            ))}
          </Card>
        ))}
      </div>
    </>
  );
}

function SlotView({ slot }: { slot: SlotStatus }) {
  return (
    <div className="slot">
      <div className="slot-head">
        <strong>{slot.label}</strong>
        <span className={slot.allowed ? "good" : "muted"}>{slot.reason}</span>
      </div>
      {slot.jobs.map((job) => (
        <div key={job.id} className="slot-job">
          <span>{job.title}</span>
          <JobSummary job={job} />
        </div>
      ))}
      {slot.jobs.length === 0 && (
        <p className="muted tight">
          {slot.queued > 0 ? `${slot.queued} waiting` : "Nothing waiting"}
        </p>
      )}
    </div>
  );
}

function PlexView({ status }: { status: StatusResponse }) {
  const plex = status.plex;
  if (!plex.configured) {
    return (
      <p>
        Not set up yet. <Link to="/settings">Add the Plex token</Link> so Kondo can see who's
        watching.
      </p>
    );
  }
  if (!plex.reachable) return <p className="bad">Can't reach Plex: {plex.error}</p>;
  if (plex.sessions.length === 0) {
    return (
      <p className="muted">
        Nobody watching{plex.quietSince ? ` · quiet since ${ago(plex.quietSince)}` : ""}
      </p>
    );
  }
  return (
    <ul className="sessions">
      {plex.sessions.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sessions have no stable id here
        <li key={i}>
          <strong>{s.title}</strong>
          <span className="muted">
            {[s.user, s.player, s.state].filter(Boolean).join(" · ")}
            {s.transcode !== "none" && ` · transcoding on the ${s.transcode.toUpperCase()}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  return (
    <li>
      <Dot status={check.status} />
      <span>
        <strong>{check.label}</strong> <span className="muted">{check.message}</span>
      </span>
    </li>
  );
}

// Jobs -----------------------------------------------------------------------

export function JobsPage() {
  return (
    <>
      <h1>Jobs</h1>
      <JobList limit={200} empty="No jobs yet. Tools add work here." />
    </>
  );
}

// Settings -------------------------------------------------------------------

const GROUPS: { id: SettingsSection["group"]; title: string }[] = [
  { id: "core", title: "Kondo" },
  { id: "integration", title: "Connections" },
  { id: "tool", title: "Tools" },
];

export function SettingsPage() {
  const { data, error, setData } = useApi<SettingsResponse>(
    "/api/settings",
    (event) => event.type === "settings.changed",
  );
  if (error) return <p className="bad">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>Settings</h1>
      <TimeZoneList />
      {GROUPS.map((group) => {
        const sections = data.sections.filter((s) => s.group === group.id);
        if (sections.length === 0) return null;
        return (
          <section key={group.id} className="settings-group">
            <h2 className="group-title">{group.title}</h2>
            {sections.map((section) => (
              <SettingsForm
                key={section.scope}
                section={section}
                values={data.values[section.scope] ?? {}}
                onSaved={setData}
              />
            ))}
          </section>
        );
      })}
    </>
  );
}

// Tool pages -----------------------------------------------------------------

export function ToolPage({ id }: { id: string }) {
  const Page = toolPages[id];
  if (!Page) return <NotFound />;
  return <Page />;
}

export function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p>
        <Link to="/">Back to the dashboard</Link>
      </p>
    </>
  );
}
