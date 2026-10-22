import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Menu, X } from "lucide-react";
import {
  send,
  useResource,
  type List,
  type Organization,
  type Project,
  type User,
} from "../api";
import { Brand } from "../components/Brand";
import { Icon } from "../components/controls";
import {
  AsyncForm,
  ErrorNotice,
  Field,
  Loading,
  Modal,
} from "../components/ui";
import { AdministrationPage } from "../features/administration";
import { PersonalSettings } from "../features/personal-settings";
import { OrganizationNav } from "./Navigation";
import { OrganizationShell } from "./OrganizationShell";

const AccountsPage = lazy(() => import("../features/platform-admin").then(m => ({ default: m.AccountsPage })));
const PlatformSettings = lazy(() => import("../features/platform-admin").then(m => ({ default: m.PlatformSettings })));

export function Shell({
  user,
  onUserChange,
  logout,
}: {
  user: User;
  onUserChange: (user: User) => void;
  logout: () => Promise<void>;
}) {
  const organizations = useResource<List<Organization>>(
    "/enterprise/api/organizations",
  );
  const [creating, setCreating] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [error, setError] = useState("");
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const orgRoute = location.pathname.match(/^\/organizations\/([^/]+)/)?.[1];
  const memberOrganization = organizations.data?.items.length === 1
    ? organizations.data.items[0]
    : undefined;
  const accountReturn = orgRoute
    ? `?returnTo=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`
    : location.pathname === "/personal-settings" ? location.search : "";
  useEffect(() => setMobileOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const resize = () => {
      if (!query.matches) setMobileOpen(false);
    };
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    sidebar.current?.querySelector<HTMLButtonElement>(".mobile-close")?.focus();
    return () => menuButton.current?.focus();
  }, [mobileOpen]);
  return (
    <div className={`app-shell ${!orgRoute ? "platform-shell" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="platform-header" inert={mobileOpen}>
        <div className="platform-brand-row">
          {orgRoute ? <button
            ref={menuButton}
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Icon icon={Menu} size={18} weight="control" />
          </button> : null}
          <Brand />
        </div>
        <nav aria-label="Platform navigation">
          {user.role === "owner" ? <>
            <Link to="/">Organizations</Link>
            <Link to="/accounts">Accounts</Link>
            <Link to="/platform-settings">Platform settings</Link>
          </> : memberOrganization ? (
            <Link to={`/organizations/${memberOrganization.id}/workspaces`}>{memberOrganization.name}</Link>
          ) : <Link to="/">Your organizations</Link>}
          <Link to={`/personal-settings${accountReturn}`}>Personal settings</Link>
          <button className="text-button" onClick={() => {
            setError("");
            logout().catch(e => setError(e.message));
          }}>Sign out</button>
        </nav>
        <ErrorNotice message={error} />
      </header>
      <div className="shell-body">
        {mobileOpen ? (
          <button
            className="sidebar-backdrop"
            tabIndex={-1}
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}
        {orgRoute ? <aside
          ref={sidebar}
          role={mobileOpen ? "dialog" : undefined}
          aria-modal={mobileOpen || undefined}
          aria-label={mobileOpen ? "Navigation" : undefined}
          className={`sidebar ${mobileOpen ? "open" : ""}`}
          onClick={event => { if (mobileOpen && event.target instanceof Element && event.target.closest("a[href]")) setMobileOpen(false); }}
          onKeyDown={(event) => {
            if (!mobileOpen) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setMobileOpen(false);
            }
            if (event.key === "Tab") {
              const controls = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  "a[href],button:not([disabled]),select:not([disabled]),input:not([disabled]),summary",
                ),
              ).filter((element) => element.checkVisibility());
              const first = controls[0];
              const last = controls.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          {mobileOpen ? <div className="sidebar-top">
            <button
              className="icon-button mobile-close"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            >
              <Icon icon={X} size={16} weight="control" />
            </button>
          </div> : null}
          <Routes>
            <Route
              path="/organizations/:orgId/*"
              element={
                <OrganizationNav
                  user={user}
                  organizations={organizations.data?.items ?? []}
                />
              }
            />
          </Routes>
        </aside> : null}
        <main
          id="main"
          className={`main-content ${/\/organizations\/[^/]+\/workspaces\/[^/]+/.test(location.pathname) ? "project-workspace" : ""}`}
          inert={mobileOpen}
        >
          {organizations.loading ? (
            <Loading />
          ) : organizations.error ? (
            <ErrorNotice message={organizations.error} />
          ) : (
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/accounts" element={user.role === "owner" ? <AccountsPage /> : <Navigate to="/" replace />} />
                <Route path="/platform-settings" element={user.role === "owner" ? <PlatformSettings /> : <Navigate to="/" replace />} />
                <Route
                  path="/"
                  element={
                    <AdministrationPage
                      user={user}
                      organizations={organizations.data?.items ?? []}
                      onCreate={() => setCreating(true)}
                    />
                  }
                />
                <Route
                  path="/personal-settings"
                  element={
                    <PersonalSettings user={user} onUserChange={onUserChange} />
                  }
                />
                <Route
                  path="/projects/:projectId/*"
                  element={<LegacyProjectRedirect />}
                />
                <Route path="/workspaces/:projectId/*" element={<LegacyProjectRedirect />} />
                <Route
                  path="/organizations/:orgId/*"
                  element={
                    <OrganizationShell
                      user={user}
                      onUserChange={onUserChange}
                      organizations={organizations.data?.items ?? []}
                      refreshOrganizations={organizations.reload}
                    />
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          )}
        </main>
      </div>
      {creating ? (
        <Modal title="New organization" onClose={() => setCreating(false)}>
          <AsyncForm
            submitLabel="Create organization"
            onCancel={() => setCreating(false)}
            onSubmit={async (data) => {
              const result = await send<Organization>(
                "/enterprise/api/organizations",
                {
                  name: data.get("name"),
                },
              );
              organizations.reload();
              setCreating(false);
              navigate(`/organizations/${result.id}/workspaces`);
            }}
          >
            <Field label="Organization name">
              <input name="name" required maxLength={160} autoFocus />
            </Field>
          </AsyncForm>
        </Modal>
      ) : null}
    </div>
  );
}

function LegacyProjectRedirect() {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const project = useResource<Project>(
    projectId ? `/enterprise/api/projects/${projectId}` : null,
  );
  if (project.loading) return <Loading />;
  if (!project.data)
    return <ErrorNotice message={project.error || "Workspace not found."} />;
  const suffix = location.pathname
    .replace(new RegExp(`^/(?:projects|workspaces)/${projectId}`), "")
    .replace(/^\/+/, "");
  const target = `/organizations/${project.data.orgId}/workspaces/${project.data.id}${suffix ? `/${suffix}` : ""}${location.search}`;
  return <Navigate to={target} replace />;
}
