import { lazy } from "react";
import {
  Navigate,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useParams,
} from "react-router-dom";
import type { Organization, User } from "../api";
import { ErrorNotice } from "../components/ui";
import {
  ProjectsPage,
  ProjectPage,
  MembersPage,
  SettingsPage,
} from "../features/projects";
import { WorkspaceContext } from "../workspace";

const DeletedProjectsPage = lazy(() =>
  import("../features/trash").then((m) => ({ default: m.DeletedProjectsPage })),
);

const SourcePage = lazy(() =>
  import("../features/source").then((module) => ({
    default: module.SourcePage,
  })),
);
const ConnectionsPage = lazy(() =>
  import("../features/connections").then((m) => ({
    default: m.ConnectionsPage,
  })),
);
const LibraryPage = lazy(() =>
  import("../features/library").then((m) => ({ default: m.LibraryPage })),
);

export function OrganizationShell({
  user,
  onUserChange,
  organizations,
  refreshOrganizations,
}: {
  user: User;
  onUserChange: (user: User) => void;
  organizations: Organization[];
  refreshOrganizations: () => void;
}) {
  const { orgId = "" } = useParams();
  const org = organizations.find((item) => item.id === orgId);
  const navigate = useNavigate();
  if (!org) return <ErrorNotice message="Organization not found." />;
  const isAdmin = user.role === "owner" || org?.role === "admin";
  const orgBase = `/organizations/${org.id}`;
  return (
    <WorkspaceContext.Provider
      key={org.id}
      value={{
        user,
        onUserChange,
        org,
        isAdmin,
        libraryFull: org.libraryAccess === "write",
        refreshOrganizations,
        selectOrganization: (nextOrgId) =>
          navigate(`/organizations/${nextOrgId}/workspaces`),
        orgBase,
      }}
    >
      <Routes>
        <Route path="workspaces" element={<ProjectsPage canSwitchOrganization={organizations.length > 1} />} />
        <Route path="settings/deleted-projects" element={<Navigate to={`${orgBase}/settings/deleted-workspaces`} replace />} />
        <Route path="projects/*" element={<OrganizationLegacyRedirect />} />
        <Route path="workspaces/:projectId/*" element={<ProjectPage />} />
        <Route
          path="files"
          element={<LibraryPage key={org.id} />}
        />
        <Route path="source/:fileId" element={<SourcePage />} />
        <Route path="library" element={<Navigate to={`${orgBase}/files`} replace />} />
        <Route
          path="members"
          element={
            isAdmin ? (
              <MembersPage />
            ) : (
              <Navigate to={`${orgBase}/workspaces`} replace />
            )
          }
        />
        <Route
          path="connections"
          element={
            isAdmin ? (
              <ConnectionsPage key={org.id} />
            ) : (
              <Navigate to={`${orgBase}/workspaces`} replace />
            )
          }
        />
        <Route
          path="settings"
          element={
            isAdmin ? (
              <SettingsPage />
            ) : (
              <Navigate to={`${orgBase}/workspaces`} replace />
            )
          }
        />
        <Route
          path="settings/deleted-workspaces"
          element={
            isAdmin ? (
              <DeletedProjectsPage />
            ) : (
              <Navigate to={`${orgBase}/workspaces`} replace />
            )
          }
        />
        <Route
          path="settings/members"
          element={
            isAdmin ? (
              <Navigate to={`${orgBase}/members`} replace />
            ) : (
              <Navigate to={`${orgBase}/workspaces`} replace />
            )
          }
        />
        <Route
          path="settings/connections"
          element={
            isAdmin ? (
              <Navigate to={`${orgBase}/connections`} replace />
            ) : (
              <Navigate to={`${orgBase}/workspaces`} replace />
            )
          }
        />
        <Route
          path="*"
          element={<Navigate to={`${orgBase}/workspaces`} replace />}
        />
      </Routes>
    </WorkspaceContext.Provider>
  );
}

function OrganizationLegacyRedirect() {
  const location = useLocation();
  return <Navigate to={location.pathname.replace(/\/projects(?=\/|$)/, "/workspaces") + location.search} replace />;
}
