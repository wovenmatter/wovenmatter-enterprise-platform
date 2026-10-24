import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Organization, User } from "../api";
import { Brand } from "../components/Brand";
import { ErrorNotice } from "../components/ui";

/** The same global destinations, in the same order, on every page. */
export function PlatformHeader({ user, organizations = [], logout, inert = false }: {
  user: User | null;
  organizations?: Organization[];
  logout: () => Promise<void>;
  inert?: boolean;
}) {
  const location = useLocation();
  const [error, setError] = useState("");
  const orgRoute = location.pathname.match(/^\/organizations\/([^/]+)/)?.[1];
  const returnOrg = location.pathname === "/personal-settings"
    ? new URLSearchParams(location.search).get("returnTo")?.match(/^\/organizations\/([^/?#]+)(?:\/|[?#]|$)/)?.[1]
    : undefined;
  const organization = organizations.find(org => org.id === (orgRoute ?? returnOrg));
  const accountReturn = orgRoute
    ? `?returnTo=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`
    : location.pathname === "/personal-settings" ? location.search : "";
  return <header className="platform-header" inert={inert}>
    <div className="platform-brand-row"><Brand /></div>
    <nav aria-label="Platform navigation">
      {user?.role === "owner" ? <Link to="/">Admin</Link> : null}
      <Link to={organization ? `/organizations/${organization.id}/workspaces` : "/organizations"}>Organization</Link>
      <Link to={`/personal-settings${accountReturn}`}>Settings</Link>
      {user ? <button className="text-button" onClick={() => {
        setError("");
        logout().catch(e => setError(e.message));
      }}>Sign out</button> : <Link to="/login">Sign in</Link>}
    </nav>
    <ErrorNotice message={error} />
  </header>;
}
