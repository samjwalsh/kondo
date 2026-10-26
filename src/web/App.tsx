import { Dot } from "./components.js";
import { Dashboard, JobsPage, NotFound, SettingsPage, ToolPage, useStatus } from "./pages.js";
import { Link, usePath } from "./router.js";

function Page({ path }: { path: string }) {
  if (path === "/") return <Dashboard />;
  if (path === "/jobs") return <JobsPage />;
  if (path === "/settings") return <SettingsPage />;
  const tool = path.match(/^\/tools\/([\w-]+)$/);
  if (tool?.[1]) return <ToolPage id={tool[1]} />;
  return <NotFound />;
}

export function App() {
  const path = usePath();
  const { data: status } = useStatus();

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Main">
        <Link to="/" exact className="brand">
          Kondo {status && <Dot status={status.health.overall} />}
        </Link>
        <Link to="/" exact>
          Dashboard
        </Link>
        <Link to="/jobs">Jobs</Link>
        {status?.tools.map((tool) => (
          <Link key={tool.id} to={`/tools/${tool.id}`}>
            {tool.name}
          </Link>
        ))}
        <Link to="/settings">Settings</Link>
        {status && <span className="version muted">v {status.version}</span>}
      </nav>
      <main className="content">
        <Page path={path} />
      </main>
    </div>
  );
}
