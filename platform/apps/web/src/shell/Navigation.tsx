import { Link, NavLink, useParams } from "react-router-dom";
import {
  Folder,
  LibraryBig,
  PanelLeftClose,
  Plus,
  Settings,
} from "lucide-react";
import type { Organization, User } from "../api";

export function AdministrationNav({
  user,
  organizations,
  onCreate,
}: {
  user: User;
  organizations: Organization[];
  onCreate: () => void;
}) {
  return (
    <nav aria-label="Administration navigation">
      {user.role === "owner" ? (
        <>
          <button className="nav-link" onClick={onCreate}>
            <Plus size={19} />
            New Organization
          </button>
          {organizations.map((org) => (
            <Link
              key={org.id}
              className="nav-link"
              to={`/organizations/${org.id}/projects`}
              title={org.name}
            >
              <Folder size={19} />
              <span className="organization-nav-name">{org.name}</span>
            </Link>
          ))}
        </>
      ) : (
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
        >
          <Folder size={19} /> Access
        </NavLink>
      )}
    </nav>
  );
}

export function OrganizationNav({
  user,
  organizations,
}: {
  user: User;
  organizations: Organization[];
}) {
  const { orgId = "" } = useParams();
  const org = organizations.find((item) => item.id === orgId);
  const isAdmin = user.role === "owner" || org?.role === "admin";
  const base = `/organizations/${orgId}`;
  const links = [
    { to: `${base}/projects`, label: "Projects", icon: Folder },
    { to: `${base}/library`, label: "Library", icon: LibraryBig },
    ...(isAdmin
      ? [
          {
            to: `${base}/settings`,
            label: "Organization settings",
            icon: Settings,
          },
        ]
      : []),
  ];
  return (
    <>
      <div className="org-title org-title-plain">
        <strong title={org?.name}>{org?.name ?? "Organization"}</strong>
        {user.role === "owner" ? (
          <Link
            to="/"
            className="icon-button admin-back-link"
            aria-label="Back to administration"
            title="Back to administration"
          >
            <PanelLeftClose size={16} strokeWidth={1.75} />
          </Link>
        ) : organizations.length > 1 ? (
          <Link to="/">Switch organization</Link>
        ) : null}
      </div>
      <nav aria-label="Main navigation">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            <Icon size={19} />
            {label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
