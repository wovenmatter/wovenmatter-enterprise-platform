import { lazy, type ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { PanelLeftClose } from "lucide-react";
import type { Organization, User } from "../api";
import { ErrorNotice } from "../components/ui";
import {
  ProjectsPage,
  ProjectPage,
  MembersPage,
  SettingsPage,
} from "../features/projects";
import { WorkspaceContext, useWorkspace } from "../workspace";

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
  organizations,
  refreshOrganizations,
}: {
  user: User;
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
        org,
        isAdmin,
        libraryFull: org.libraryAccess === "write",
        refreshOrganizations,
        selectOrganization: (nextOrgId) =>
          navigate(`/organizations/${nextOrgId}/projects`),
        orgBase,
      }}
    >
      <Routes>
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId/*" element={<ProjectPage />} />
        <Route
          path="files"
          element={<Navigate to={`${orgBase}/library`} replace />}
        />
        <Route path="source/:fileId" element={<SourcePage />} />
        <Route path="library" element={<LibraryPage key={org.id} />} />
        <Route
          path="members"
          element={
            isAdmin ? (
              <Navigate to={`${orgBase}/settings/members`} replace />
            ) : (
              <Navigate to={`${orgBase}/projects`} replace />
            )
          }
        />
        <Route
          path="connections"
          element={
            isAdmin ? (
              <Navigate to={`${orgBase}/settings/connections`} replace />
            ) : (
              <Navigate to={`${orgBase}/projects`} replace />
            )
          }
        />
        <Route
          path="settings"
          element={
            isAdmin ? (
              <SettingsPage />
            ) : (
              <Navigate to={`${orgBase}/projects`} replace />
            )
          }
        />
        <Route
          path="settings/deleted-projects"
          element={
            isAdmin ? (
              <DeletedProjectsPage />
            ) : (
              <Navigate to={`${orgBase}/projects`} replace />
            )
          }
        />
        <Route
          path="settings/members"
          element={
            isAdmin ? (
              <MembersPage nested />
            ) : (
              <Navigate to={`${orgBase}/projects`} replace />
            )
          }
        />
        <Route
          path="settings/connections"
          element={
            isAdmin ? (
              <SettingsNested title="Connections">
                <ConnectionsPage key={org.id} />
              </SettingsNested>
            ) : (
              <Navigate to={`${orgBase}/projects`} replace />
            )
          }
        />
        <Route
          path="*"
          element={<Navigate to={`${orgBase}/projects`} replace />}
        />
      </Routes>
    </WorkspaceContext.Provider>
  );
}

function SettingsNested({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { orgBase } = useWorkspace();
  return (
    <div className="settings-nested">
      <Link
        to={`${orgBase}/settings`}
        className="icon-button settings-back-link"
        aria-label="Back to organization settings"
        title="Back to organization settings"
      >
        <PanelLeftClose size={16} strokeWidth={1.75} />
      </Link>
      <span className="sr-only">{title}</span>
      {children}
    </div>
  );
}
