import { Suspense, useEffect, useRef, useState } from "react";
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
import { AsyncForm, ErrorNotice, Field, Loading, Modal } from "../components/ui";
import { AdministrationPage } from "../features/administration";
import { PersonalSettings } from "../features/personal-settings";
import { AdministrationNav, OrganizationNav } from "./Navigation";
import { OrganizationShell } from "./OrganizationShell";

export function Shell({
  user,
  onUserChange,
  logout,
}: {
  user: User;
  onUserChange: (user: User) => void;
  logout: () => Promise<void>;
}) {
  const organizations = useResource<List<Organization>>("/api/organizations");
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
  useEffect(() => setMobileOpen(false), [location.pathname]);
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
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="mobile-header" inert={mobileOpen}>
        <strong className="mobile-title">{mobileTitle}</strong>
        <button
          ref={menuButton}
          className="icon-button"
          aria-label="Open navigation"
          onClick={() => setMobileOpen(true)}
        >
          <Menu size={22} />
        </button>
      </header>
      {mobileOpen ? (
        <button
          className="sidebar-backdrop"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside
        ref={sidebar}
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen || undefined}
        aria-label={mobileOpen ? "Navigation" : undefined}
        className={`sidebar ${mobileOpen ? "open" : ""}`}
        onKeyDown={(event) => {
          if (!mobileOpen) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setMobileOpen(false);
          }
          if (event.key === "Tab") {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
              "a[href],button:not([disabled]),select:not([disabled])",
            )).filter((element) => element.getClientRects().length > 0);
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
        {(!orgRoute || mobileOpen) && (<div className="sidebar-top">
          <Routes>
            <Route path="/organizations/:orgId/*" element={null} />
            <Route
              path="*"
              element={
                user.role === "owner" ? <Brand /> : (
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
            <X size={20} />
          </button>
        </div>)}
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
          <Route
            path="*"
            element={<AdministrationNav user={user} organizations={organizations.data?.items ?? []} onCreate={() => { setMobileOpen(false); setCreating(true); }} />}
          />
        </Routes>
        <div className="sidebar-footer">
          <Link className="account nav-link" to={`/personal-settings${accountReturn}`}
            title={`Settings · ${user.name || user.email}`}>
            <Settings size={18} />
            <span className="account-label">Settings <span className="account-name">· {user.name || user.email}</span></span>
          </Link>
          <button
            className="nav-link"
            onClick={() => {
              setError("");
              logout().catch((e) => setError(e.message));
            }}
          >
            <LogOut size={18} />
            Sign out
          </button>
          <ErrorNotice message={error} />
        </div>
      </aside>
      <main id="main" className="main-content" inert={mobileOpen}>
        {organizations.loading ? (
          <Loading />
        ) : organizations.error ? (
          <ErrorNotice message={organizations.error} />
        ) : (
          <Suspense fallback={<Loading />}>
            <Routes>
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
                element={<PersonalSettings user={user} onUserChange={onUserChange} />}
              />
              <Route path="/projects/:projectId/*" element={<LegacyProjectRedirect />} />
              <Route
                path="/organizations/:orgId/*"
                element={
                  <OrganizationShell
                    user={user}
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
              const result = await send<Organization>("/api/organizations", {
                name: data.get("name"),
              });
              organizations.reload();
              setCreating(false);
              navigate(`/organizations/${result.id}/projects`);
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
    projectId ? `/api/projects/${projectId}` : null,
  );
  if (project.loading) return <Loading />;
  if (!project.data)
    return <ErrorNotice message={project.error || "Project not found."} />;
  const suffix = location.pathname
    .replace(new RegExp(`^/projects/${projectId}`), "")
    .replace(/^\/+/, "");
  const target = `/organizations/${project.data.orgId}/projects/${project.data.id}${suffix ? `/${suffix}` : ""}${location.search}`;
  return <Navigate to={target} replace />;
}
