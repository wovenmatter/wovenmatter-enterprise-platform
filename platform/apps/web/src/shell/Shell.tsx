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
import { LogOut, Menu, Settings, X } from "lucide-react";
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
  const currentOrg = orgRoute
    ? organizations.data?.items.find((item) => item.id === orgRoute)
    : undefined;
  const mobileTitle = currentOrg
    ? currentOrg.name
    : user.role === "owner"
      ? "Administration"
      : "Your access";
  const accountReturn = location.pathname.startsWith("/organizations/")
    ? `?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`
    : "";
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
      {!orgRoute ? <header className="platform-header"><Link to="/" aria-label="WovenMatter home"><Brand /></Link><nav aria-label="Platform navigation"><Link to="/">{user.role === "owner" ? "Organizations" : "Your organizations"}</Link>{user.role === "owner" ? <><Link to="/accounts">Accounts</Link><Link to="/platform-settings">Platform settings</Link></> : null}<Link to="/personal-settings">Personal settings</Link><button className="text-button" onClick={() => logout().catch(e => setError(e.message))}>Sign out</button></nav></header> : null}
      {orgRoute ? <header className="mobile-header" inert={mobileOpen}>
        <button
          ref={menuButton}
          className="icon-button"
          aria-label="Open navigation"
          onClick={() => setMobileOpen(true)}
        >
          <Icon icon={Menu} size={18} weight="control" />
        </button>
        <strong className="mobile-title">{mobileTitle}</strong>
      </header> : null}
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
                "a[href],button:not([disabled]),select:not([disabled]),input:not([disabled])",
              ),
            ).filter((element) => element.getClientRects().length > 0);
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
        {(!orgRoute || mobileOpen) && (
          <div className="sidebar-top">
            <Routes>
              <Route path="/organizations/:orgId/*" element={null} />
              <Route
                path="*"
                element={
                  user.role === "owner" ? (
                    <Brand />
                  ) : (
                    <strong className="sidebar-heading">Your access</strong>
                  )
                }
              />
            </Routes>
            <button
              className="icon-button mobile-close"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            >
              <Icon icon={X} size={16} weight="control" />
            </button>
          </div>
        )}
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
        <div className="sidebar-footer">
          <Link
            className="account nav-link"
            to={`/personal-settings${accountReturn}`}
            title={`Settings · ${user.name || user.email}`}
          >
            <Icon icon={Settings} size={13} />
            <span className="account-label">
              Settings{" "}
              <span className="account-name">· {user.name || user.email}</span>
            </span>
          </Link>
          <button
            type="button"
            className="nav-link"
            onClick={() => {
              setError("");
              logout().catch((e) => setError(e.message));
            }}
          >
            <Icon icon={LogOut} size={13} />
            <span>Sign out</span>
          </button>
          <ErrorNotice message={error} />
        </div>
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
