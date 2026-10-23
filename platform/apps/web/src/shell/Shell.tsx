import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Menu, PanelLeft, PanelRight, X } from "lucide-react";
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
import { SidebarProvider, focusSidebarControl, useSidebar } from "./sidebar-preferences";
import "./sidebar.css";

const AccountsPage = lazy(() => import("../features/platform-admin").then(m => ({ default: m.AccountsPage })));
const PlatformSettings = lazy(() => import("../features/platform-admin").then(m => ({ default: m.PlatformSettings })));

export function Shell(props: { user: User; onUserChange: (user: User) => void; logout: () => Promise<void> }) {
  return <SidebarProvider key={props.user.id} userId={props.user.id}><ShellContent {...props} /></SidebarProvider>;
}

function ShellContent({
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
  const { preferences, update, narrow, compact, drawerWidth, pagedAdaptive, workspaceBase, contentsSelected, setContentTarget, drawer, setDrawer, drawerOpener } = useSidebar();
  const split = !workspaceBase || preferences.style === "split";
  const isCompact = workspaceBase ? compact : narrow;
  const adaptive = Boolean(workspaceBase && preferences.style === "adaptive");
  const singleContent = !split && contentsSelected;
  const expanded = adaptive && contentsSelected && !(isCompact && pagedAdaptive);
  const navigationVisible = workspaceBase ? split ? preferences.navigationVisible : preferences.singleVisible && (adaptive || !singleContent) : true;
  const contentVisible = Boolean(workspaceBase && (split ? preferences.contentVisible : preferences.singleVisible && singleContent));
  const mobileOpen = isCompact && drawer !== null;
  const showNavigation = isCompact ? mobileOpen && (expanded || drawer === "navigation") : navigationVisible;
  const showContent = isCompact ? mobileOpen && (expanded || drawer === "content") : contentVisible;
  const lastDrawer = useRef<"navigation" | "content">("navigation");
  if (drawer) lastDrawer.current = drawer;
  const side = split ? (drawer ?? lastDrawer.current) === "content" ? "right" : "left" : preferences.side;
  const pageWidth = isCompact ? drawerWidth : 256;
  const groupWidth = pageWidth * (expanded ? 2 : 1);
  const groupLeft = split && !isCompact ? "8px" : side === "left" ? isCompact ? "0px" : "8px" : `calc(100% - ${groupWidth + (isCompact ? 0 : 8)}px)`;
  const groupShown = isCompact ? mobileOpen : split || preferences.singleVisible;
  const leftSpace = isCompact ? 0 : split ? navigationVisible ? 264 : 0 : preferences.side === "left" && preferences.singleVisible ? groupWidth + 8 : 0;
  const rightSpace = isCompact ? 0 : split ? contentVisible ? 264 : 0 : preferences.side === "right" && preferences.singleVisible ? groupWidth + 8 : 0;
  const revealNavigation = Boolean(workspaceBase && (isCompact || (split ? !navigationVisible : !preferences.singleVisible)));
  const revealContent = Boolean(workspaceBase && split && (isCompact || !contentVisible));
  const layoutStyle = {
    "--sidebar-page-width": `${pageWidth}px`,
    "--sidebar-group-width": split && !isCompact ? "calc(100% - 16px)" : `${groupWidth}px`,
    "--sidebar-group-left": groupLeft,
    "--sidebar-group-opacity": groupShown ? 1 : 0,
    "--sidebar-group-offset": groupShown ? "0px" : side === "left" ? `-${groupWidth + 8}px` : `${groupWidth + 8}px`,
    "--sidebar-nav-left": expanded && side === "right" ? `${pageWidth}px` : "0px",
    "--sidebar-content-left": split && !isCompact ? "calc(100% - 256px)" : expanded && side === "left" ? `${pageWidth}px` : "0px",
    "--sidebar-center-left": `${(isCompact ? 0 : 8) + leftSpace}px`,
    "--sidebar-center-width": `calc(100% - ${(isCompact ? 0 : 16) + leftSpace + rightSpace}px)`,
    "--sidebar-center-offset": mobileOpen ? `${side === "left" ? groupWidth : -groupWidth}px` : "0px",
  } as CSSProperties;
  const drawerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
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
  function openDrawer(page: "navigation" | "content") {
    drawerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : menuButton.current;
    setDrawer(page);
  }
  useEffect(() => {
    if (!isCompact) setDrawer(null);
  }, [isCompact, setDrawer]);
  useEffect(() => {
    if (!mobileOpen) return;
    drawerRef.current?.querySelector<HTMLButtonElement>(".mobile-close")?.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => {
        if (document.querySelector("dialog[open]")) return;
        const target = drawerOpener.current;
        const reveal = document.querySelector<HTMLElement>(`[data-sidebar-reveal="${split ? drawer : "single"}"]`);
        if (reveal?.checkVisibility()) reveal.focus({ preventScroll: true });
        else if (target?.checkVisibility()) target.focus({ preventScroll: true });
        else menuButton.current?.focus({ preventScroll: true });
      });
    };
  }, [mobileOpen]);
  function reveal(page: "navigation" | "content") {
    if (isCompact) {
      if (!split) update({ singleVisible: true });
      openDrawer(page); return;
    }
    update(split ? page === "navigation" ? { navigationVisible: true } : { contentVisible: true } : { singleVisible: true });
    focusSidebarControl(`[data-sidebar-hide="${page}"]`);
  }
  return (
    <div className={`app-shell ${!orgRoute ? "platform-shell" : "sidebar-shell"}`} data-sidebar-style={workspaceBase ? preferences.style : "organization"} data-sidebar-side={preferences.side} data-compact={isCompact} data-drawer-open={mobileOpen}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="platform-header" inert={mobileOpen}>
        <div className="platform-brand-row">
          {orgRoute && !workspaceBase ? <button
            ref={menuButton}
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => openDrawer(singleContent ? "content" : "navigation")}
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
      <div className="shell-body" style={orgRoute ? layoutStyle : undefined}>
        {mobileOpen ? (
          <button
            className="sidebar-backdrop"
            tabIndex={-1}
            aria-label="Close navigation"
            onClick={() => setDrawer(null)}
          />
        ) : null}
        {orgRoute ? <div
          ref={drawerRef}
          role={mobileOpen ? "dialog" : undefined}
          aria-modal={mobileOpen || undefined}
          aria-label={mobileOpen ? drawer === "content" ? "Workspace sidebar" : "Navigation" : undefined}
          className={`sidebar-layout ${mobileOpen ? "drawer-open" : ""} ${expanded ? "adaptive-expanded" : ""}`}
          data-drawer={drawer ?? undefined}
          data-side={side}
          onClick={event => {
            if (!mobileOpen || !(event.target instanceof Element)) return;
            const link = event.target.closest("a[href]");
            if (link && !(link.hasAttribute("data-folder-selection") && !split)) setDrawer(null);
          }}
          onKeyDown={(event) => {
            if (!mobileOpen || event.target instanceof Element && event.target.closest("dialog[open]")) return;
            if (event.key === "Escape") { event.preventDefault(); setDrawer(null); }
            if (event.key === "Tab") {
              const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),select:not([disabled]),input:not([disabled]),summary")).filter(element => element.checkVisibility() && !element.closest("[inert]"));
              const first = controls[0], last = controls.at(-1);
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus({ preventScroll: true }); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }); }
            }
          }}
        >
          <div className="sidebar-top" hidden={!mobileOpen}>
            <button
              className="icon-button mobile-close"
              aria-label="Close navigation"
              onClick={() => setDrawer(null)}
            >
              <Icon icon={X} size={16} weight="control" />
            </button>
          </div>
          <aside className={`sidebar ${showNavigation ? "rail-visible" : "rail-hidden"}`} aria-label="Organization sidebar" inert={!showNavigation}>
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
          </aside>
          <div ref={setContentTarget} className={`sidebar-content-slot ${showContent ? "rail-visible" : "rail-hidden"}`} inert={!showContent} />
        </div> : null}
        <main
          id="main"
          className={`main-content ${/\/organizations\/[^/]+\/workspaces\/[^/]+/.test(location.pathname) ? "project-workspace" : ""}`}
          inert={mobileOpen}
          data-reveal-space={revealNavigation || revealContent}
        >
          {workspaceBase ? <div className="workspace-reveal-controls">
            {revealNavigation ? <button type="button" className="icon-button sidebar-reveal" data-side={split ? "left" : preferences.side} data-sidebar-reveal={split ? "navigation" : "single"} aria-label="Show navigation sidebar" title="Show navigation sidebar" onClick={() => reveal(!split && singleContent ? "content" : "navigation")}><Icon icon={!split && preferences.side === "right" ? PanelRight : PanelLeft} size={18} /></button> : null}
            {revealContent ? <button type="button" className="icon-button sidebar-reveal" data-side="right" data-sidebar-reveal="content" aria-label="Show workspace sidebar" title="Show workspace sidebar" onClick={() => reveal("content")}><Icon icon={PanelRight} size={18} /></button> : null}
          </div> : null}
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
