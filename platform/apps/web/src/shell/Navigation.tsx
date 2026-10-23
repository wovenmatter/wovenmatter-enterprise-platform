import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, Cable, Files, FolderOpen, Settings, Users } from "lucide-react";
import type { Organization, User } from "../api";
import { Icon } from "../components/controls";
import { ProjectNavigation } from "./ProjectNavigation";

export function OrganizationNav({ user, organizations }: { user: User; organizations: Organization[] }) {
  const { orgId = "" } = useParams();
  const location = useLocation();
  const org = organizations.find(item => item.id === orgId);
  const isAdmin = user.role === "owner" || org?.role === "admin";
  const base = `/organizations/${orgId}`;
  const inWorkspace = /\/workspaces\/[^/]+/.test(location.pathname);
  const links = [
    { to: `${base}/workspaces`, label: "Workspaces", icon: FolderOpen },
    { to: `${base}/files`, label: "Organization Files", icon: Files },
    ...(isAdmin ? [
      { to: `${base}/members`, label: "Members", icon: Users },
      { to: `${base}/connections`, label: "Connections", icon: Cable },
      { to: `${base}/settings`, label: "Settings", icon: Settings },
    ] : []),
  ];
  return <>
    {!inWorkspace ? <>
      <div className="org-title org-title-plain"><strong title={org?.name}>{org?.name ?? "Organization"}</strong></div>
      {user.role === "owner" || organizations.length > 1 ? <Link className="nav-link org-back" to="/"><Icon icon={ArrowLeft} size={13} weight="control" /><span>{user.role === "owner" ? "Administration" : "Your organizations"}</span></Link> : null}
      <nav aria-label="Organization navigation" className="organization-navigation">
        {links.map(({ to, label, icon }) => <NavLink key={to} to={to} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}><Icon icon={icon} size={13} /><span>{label}</span></NavLink>)}
      </nav>
    </> : <ProjectNavigation key={orgId} orgId={orgId} user={user} isAdmin={isAdmin} />}
  </>;
}
