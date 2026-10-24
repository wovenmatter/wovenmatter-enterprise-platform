import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { ChevronDown, Menu as MenuIcon, X } from "lucide-react";
import {
  send,
  useResource,
  type List,
  type Organization,
  type Project,
  type User,
} from "../api";
import { Brand } from "../components/Brand";
import { Icon, Menu, MenuItem } from "../components/controls";
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
import { hasPendingSidebarFocusFrom, SidebarProvider, useSidebar } from "./sidebar-preferences";
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
  const { preferences, update, narrow, compact, pagedAdaptive, workspaceBase, contentsSelected, setContentTarget, drawer, setDrawer, drawerOpener } = useSidebar();
  const split = !workspaceBase || preferences.style === "split";
  const isCompact = workspaceBase ? compact : narrow;
  const adaptive = Boolean(workspaceBase && preferences.style === "adaptive");
  const singleContent = !split && contentsSelected;
  const expanded = adaptive && contentsSelected && !pagedAdaptive;
  const [splitPage, setSplitPage] = useState<"navigation" | "content">("navigation");
  const pagedSplit = Boolean(workspaceBase && split && pagedAdaptive);
  const navigationVisible = workspaceBase ? split ? preferences.navigationVisible : preferences.singleVisible && (!singleContent || expanded) : true;
  const contentVisible = Boolean(workspaceBase && (split ? preferences.contentVisible : preferences.singleVisible && singleContent));
  const mobileOpen = isCompact && drawer !== null;
  const showNavigation = isCompact ? mobileOpen && drawer === "navigation" : navigationVisible && (!pagedSplit || splitPage === "navigation" || !contentVisible);
  const showContent = isCompact ? mobileOpen && drawer === "content" : contentVisible && (!pagedSplit || splitPage === "content" || !navigationVisible);
  const lastDrawer = useRef<"navigation" | "content">("navigation");
  if (drawer) lastDrawer.current = drawer;
  const side = split ? (drawer ?? lastDrawer.current) === "content" ? "right" : "left" : preferences.side;
  const pageWidth = 256;
  const groupWidth = pageWidth * (expanded ? 2 : 1);
  const groupLeft = split || side === "left" ? "8px" : `calc(100% - ${groupWidth + 8}px)`;
  const groupShown = isCompact ? mobileOpen : split || preferences.singleVisible;
  const leftSpace = isCompact ? 0 : split ? showNavigation ? 264 : 0 : preferences.side === "left" && preferences.singleVisible ? groupWidth + 8 : 0;
  const rightSpace = isCompact ? 0 : split ? showContent ? 264 : 0 : preferences.side === "right" && preferences.singleVisible ? groupWidth + 8 : 0;
  const groupOpen = showNavigation || showContent;
  const activePage = showContent ? "content" : "navigation";
  // The same focusable control travels horizontally between the title and
  // the outside edge. It never duplicates a reveal button inside the center.
  const toggleLeft = (open: boolean, edge: "left" | "right", width = 256) => edge === "left"
    ? `${open ? width - 44 : 20}px`
    : `calc(100% - ${open ? width - 8 : 56}px)`;
  const layoutStyle = {
    "--sidebar-page-width": `${pageWidth}px`,
    "--sidebar-group-width": split ? "calc(100% - 16px)" : `${groupWidth}px`,
    "--sidebar-group-left": groupLeft,
    "--sidebar-group-opacity": groupShown ? 1 : 0,
    "--sidebar-group-offset": groupShown || split ? "0px" : side === "left" ? `-${groupWidth + 8}px` : `${groupWidth + 8}px`,
    "--sidebar-nav-left": expanded && side === "right" ? `${pageWidth}px` : "0px",
    "--sidebar-content-left": split ? "calc(100% - 256px)" : expanded && side === "left" ? `${pageWidth}px` : "0px",
    "--sidebar-center-left": `${8 + leftSpace}px`,
    "--sidebar-center-width": `calc(100% - ${16 + leftSpace + rightSpace}px)`,
    "--sidebar-toggle-left": toggleLeft(split ? showNavigation : groupOpen, split ? "left" : side, split ? 256 : groupWidth),
    "--sidebar-toggle-right": toggleLeft(showContent, "right"),
    "--sidebar-header-left": workspaceBase && !(split ? showNavigation : groupOpen || side === "right") ? "52px" : "0px",
    "--sidebar-header-right": workspaceBase && (split ? !showContent : !groupOpen && side === "right") ? "52px" : "0px",
  } as CSSProperties;
  const drawerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // A resize can page away the focused rail without a click. Move focus before
    // the browser drops it from the newly inert subtree to the document body.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest(".rail-hidden")) return;
    // Folder navigation already has a handoff from this control to a visible
    // destination. Keep this fallback for resize-only focus recovery.
    if (hasPendingSidebarFocusFrom(active)) return;
    const page = split && active.closest(".sidebar-content-slot") ? "content" : "navigation";
    const target = drawerRef.current?.querySelector<HTMLElement>(mobileOpen ? "[data-sidebar-hide]" : `[data-toggle="${page}"]`);
    target?.focus({ preventScroll: true });
  }, [showNavigation, showContent, mobileOpen, split]);
  const [error, setError] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const orgRoute = location.pathname.match(/^\/organizations\/([^/]+)/)?.[1];
  const memberOrganization = organizations.data?.items.length === 1
    ? organizations.data.items[0]
    : undefined;
  const returnOrg = location.pathname === "/personal-settings"
    ? new URLSearchParams(location.search).get("returnTo")?.match(/^\/organizations\/([^/?#]+)(?:\/|[?#]|$)/)?.[1]
    : undefined;
  const activeOrganization = organizations.data?.items.find(org => org.id === (orgRoute ?? returnOrg))
    ?? (!orgRoute && !returnOrg ? memberOrganization : undefined);
  const adminContext = user.role === "owner" && ["/", "/accounts", "/platform-settings"].includes(location.pathname.replace(/\/$/, "") || "/");
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
    drawerRef.current?.querySelector<HTMLButtonElement>(workspaceBase ? "[data-sidebar-hide]" : ".mobile-close")?.focus({ preventScroll: true });
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
  function toggle(page: "navigation" | "content", open: boolean) {
    if (isCompact) {
      if (open) setDrawer(null);
      else openDrawer(page);
      return;
    }
    if (split) {
      update(page === "navigation" ? { navigationVisible: !open } : { contentVisible: !open });
      setSplitPage(page);
    } else update({ singleVisible: !open });
  }
  function sidebarToggle(page: "navigation" | "content") {
    const open = split ? page === "navigation" ? showNavigation : showContent : groupOpen;
    const edge = split ? page === "navigation" ? "left" : "right" : side;
    const target = split ? page : singleContent ? "content" : "navigation";
    const name = split && page === "content" ? "workspace" : "navigation";
    return <button type="button" className="icon-button sidebar-toggle" data-toggle={page}
      data-sidebar-hide={open ? split ? page : activePage : undefined}
      data-sidebar-reveal={!open ? split ? page : "single" : undefined}
      inert={mobileOpen && !open}
      aria-label={`${open ? "Hide" : "Show"} ${name} sidebar`} title={`${open ? "Hide" : "Show"} sidebar`}
      onClick={() => toggle(target, open)}>
      <SidebarGlyph side={open ? edge : edge === "left" ? "right" : "left"} />
    </button>;
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
            <Icon icon={MenuIcon} size={18} weight="control" />
          </button> : null}
          <Brand />
        </div>
        <nav aria-label="Platform navigation">
          {adminContext ? <>
            <Link to="/">Organizations</Link>
            <Link to="/accounts">Accounts</Link>
            <Link to="/platform-settings">Platform settings</Link>
          </> : <>
            {activeOrganization ? <div className="organization-topbar-links">
              <Link to={`/organizations/${activeOrganization.id}/workspaces`}>Your organization</Link>
              {user.role !== "owner" && (organizations.data?.items.length ?? 0) > 1 ?
                <Menu label="Switch organization" icon={ChevronDown} iconSize={12} className="organization-switch" align="start">
                  {organizations.data?.items.filter(org => org.id !== activeOrganization.id).map(org => <MenuItem key={org.id} onSelect={() => navigate(`/organizations/${org.id}/workspaces`)}>{org.name}</MenuItem>)}
                </Menu> : null}
            </div> : user.role !== "owner" ? <Link to="/">Your organizations</Link> : null}
            {user.role === "owner" ? <Link to="/">Admin</Link> : null}
          </>}
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
          className={`sidebar-container ${mobileOpen ? "drawer-open" : ""}`}
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
          {workspaceBase ? <>{sidebarToggle("navigation")}{split ? sidebarToggle("content") : null}</> : null}
          <div className={`sidebar-layout ${expanded ? "adaptive-expanded" : ""}`} data-side={side}>
          {!workspaceBase ? <div className="sidebar-top" hidden={!mobileOpen}>
            <button
              className="icon-button mobile-close"
              aria-label="Close navigation"
              onClick={() => setDrawer(null)}
            >
              <Icon icon={X} size={16} weight="control" />
            </button>
          </div> : null}
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
          </div>
        </div> : null}
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

// Exact WovenMatter dashboard-{left,right}-collapse-s15 assets (PR #156).
// Reopening uses the opposite divider, as DashboardRevealRailButton does.
function SidebarGlyph({ side }: { side: "left" | "right" }) {
  const divider = side === "left" ? 8.75 : 15.25;
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="4.5" />
    <line x1={divider} y1="7.25" x2={divider} y2="16.75" />
  </svg>;
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
