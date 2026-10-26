import { lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { Cable, Folder, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import {
  api,
  date,
  errorMessage,
  send,
  useResource,
  type List,
  type Project,
  type User,
} from "../api";
import { useWorkspace } from "../workspace";
import { workspaceChanged, useWorkspaceChanges } from "../workspace-events";
import { Icon, Switch } from "../components/controls";
import {
  AsyncForm,
  BackLink,
  Card,
  Confirm,
  DestinationRow,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  PageHeader,
  Status,
  Success,
} from "../components/ui";
const FilesPage = lazy(() =>
  import("./files").then((m) => ({
    default: m.FilesPage,
  })),
);
const ConversationsPage = lazy(() =>
  import("./conversations").then((m) => ({
    default: m.ConversationsPage,
  })),
);
const NotesPage = lazy(() => import("./workspace-content").then(m => ({ default: m.NotesPage })));
const CalendarPage = lazy(() => import("./workspace-content").then(m => ({ default: m.CalendarPage })));
const UsagePage = lazy(() => import("./workspace-content").then(m => ({ default: m.UsagePage })));
const WorkspaceLibraryPage = lazy(() => import("./workspace-library").then(m => ({ default: m.WorkspaceLibraryPage })));
const DatabasesPage = lazy(() => import("./workspace-databases").then(m => ({ default: m.DatabasesPage })));
const WorkspaceBrowserPage=lazy(()=>import("./workspace-browser").then(module=>({default:module.WorkspaceBrowserPage})));
const WorkspaceSettings = lazy(() => import("./workspace-settings").then(m => ({ default: m.WorkspaceSettings })));
const ConnectionsPage = lazy(() => import("./connections").then(m => ({ default: m.ConnectionsPage })));
export function ProjectsPage({ canSwitchOrganization = false }: { canSwitchOrganization?: boolean }) {
  const { org, isAdmin, orgBase } = useWorkspace();
  const projects = useResource<List<Project>>(
    `/enterprise/api/organizations/${org.id}/projects`,
  );
  const [query, setQuery] = useSearchParams();
  const creating = query.get("new") === "1";
  const setCreating = (value: boolean) => setQuery(value ? { new: "1" } : {});
  useWorkspaceChanges(projects.reload);
  const navigate = useNavigate();
  return (
    <section>
      <PageHeader
        title="Workspaces"
        actions={<>
          {canSwitchOrganization ? <Link to="/organizations">Switch organization</Link> : null}
          {isAdmin ? <button className="primary" onClick={() => setCreating(true)}>
            <Icon icon={Plus} size={14} weight="control" />
            New workspace
          </button> : null}
        </>}
      />
      <ErrorNotice message={projects.error} onRetry={projects.reload} />
      {projects.loading && !projects.data ? (
        <Loading />
      ) : projects.error && !projects.data ? null : (
        <div className="table-wrap">
          {projects.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {projects.data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link
                        className="item-link"
                        to={`${orgBase}/workspaces/${p.id}`}
                      >
                        <Icon icon={Folder} size={16} />
                        <div>
                          <strong>{p.name}</strong>
                          {p.description ? (
                            <small>{p.description}</small>
                          ) : null}
                        </div>
                      </Link>
                    </td>
                    <td>
                      <Status value={p.status} />
                    </td>
                    <td>{date(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              title="No workspaces yet"
              action={
                isAdmin ? (
                  <button className="primary" onClick={() => setCreating(true)}>
                    Create workspace
                  </button>
                ) : null
              }
            >
              {isAdmin
                ? "Create a workspace to bring your team, files, and conversations together."
                : "Your administrator can add you to a workspace."}
            </Empty>
          )}
        </div>
      )}
      {creating ? (
        <Modal title="New workspace" onClose={() => setCreating(false)}>
          <ProjectForm
            onCancel={() => setCreating(false)}
            onSave={async (body) => {
              const p = await send<Project>(
                `/enterprise/api/organizations/${org.id}/projects`,
                body,
              );
              setCreating(false);
              projects.reload();
              workspaceChanged();
              navigate(`${orgBase}/workspaces/${p.id}`);
            }}
          />
        </Modal>
      ) : null}
    </section>
  );
}
function ProjectForm({
  project,
  onSave,
  onCancel,
}: {
  project?: Project;
  onSave: (body: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const { user, org } = useWorkspace();
  const hosts = useResource<
    List<{
      id: string;
      name: string;
    }>
  >(user.role === "owner" ? "/enterprise/api/hosts" : null);
  return (
    <AsyncForm
      submitLabel={project ? "Save changes" : "Create workspace"}
      onCancel={onCancel}
      onSubmit={async (data) =>
        onSave({
          name: data.get("name"),
          description: data.get("description"),
          ...(user.role === "owner" && !project && data.get("hostId")
            ? {
                hostId: data.get("hostId"),
              }
            : {}),
        })
      }
    >
      {user.role === "owner" ? (
        <>
          <ErrorNotice message={hosts.error} />
          <Field
            label="Workspace host"
            hint={
              project
                ? "Stored workspaces retain their assigned host."
                : "Choose an override or use the organization default."
            }
          >
            <select
              name="hostId"
              disabled={Boolean(project) || hosts.loading}
              defaultValue={project?.hostId ?? ""}
            >
              {!project ? (
                <option value="">
                  Organization default (
                  {hosts.data?.items.find((h) => h.id === org.defaultHostId)
                    ?.name ?? org.defaultHostId}
                  )
                </option>
              ) : null}
              {hosts.data?.items.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : null}
      <Field label="Workspace name">
        <input
          autoFocus
          name="name"
          required
          maxLength={160}
          defaultValue={project?.name}
        />
      </Field>
      <Field label="Description">
        <textarea
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={project?.description}
        />
      </Field>
    </AsyncForm>
  );
}
export function ProjectPage() {
  const location = useLocation();
  const { projectId } = useParams();
  const { isAdmin, org, orgBase, selectOrganization } = useWorkspace();
  const project = useResource<Project>(
    projectId ? `/enterprise/api/projects/${projectId}` : null,
    10000,
  );
  const [setupError, setSetupError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  useWorkspaceChanges(project.reload);
  useEffect(() => {
    if (project.data && project.data.orgId !== org.id)
      selectOrganization(project.data.orgId);
  }, [project.data, org.id, selectOrganization]);
  if (
    (project.loading && !project.data) ||
    (project.data && project.data.orgId !== org.id)
  )
    return <Loading />;
  if (!project.data)
    return <ErrorNotice message={project.error || "Workspace unavailable."} />;
  const p = project.data;
  return (
    <section className="project-page">
      {/\/(files|members|settings(?:\/.*)?)$/.test(location.pathname) ? (
        <header className="project-pane-header">
          <h1>{p.name}</h1>
        </header>
      ) : null}
      {p.status !== "ready" && p.status !== "active" ? (
        <div className="notice">
          <Status value={p.status} />
          <span>Workspace setup is managed in the background.</span>
          <button className="text-button" onClick={project.reload}>
            <Icon icon={RefreshCw} size={12} weight="control" />
            Refresh status
          </button>
          {isAdmin && p.status === "needs_attention" ? (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await send(`/enterprise/api/projects/${p.id}/retry`, {});
                  setSetupError("");
                  project.reload();
                } catch (e) {
                  setSetupError((e as Error).message);
                }
              }}
            >
              Retry setup
            </button>
          ) : null}
        </div>
      ) : null}
      <ErrorNotice message={setupError} />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route index element={<ConversationsPage key={p.id} project={p} />} />
          <Route path="files" element={<FilesPage key={p.id} project={p} />} />
          <Route path="members" element={isAdmin ? <ProjectMembers project={p} /> : <ErrorNotice message="Organization administrator access required." />} />
          <Route path="notes" element={<NotesPage project={p} />} />
          <Route path="artifacts" element={<NotesPage key="artifacts" project={p} kind="artifact" />} />
          <Route path="calendar" element={<CalendarPage project={p} />} />
          <Route path="tasks" element={<CalendarPage key="tasks" project={p} tasksOnly />} />
          <Route path="library" element={<WorkspaceLibraryPage project={p} />} />
          <Route path="databases" element={<DatabasesPage project={p} />} />
          <Route path="usage" element={<UsagePage project={p} />} />
          <Route path="browser" element={<WorkspaceBrowserPage project={p}/>} />
          <Route path="connections" element={isAdmin ? <ConnectionsPage projectId={p.id} /> : <ErrorNotice message="Organization administrator access required." />} />
          <Route
            path="settings/*"
            element={<WorkspaceSettings project={p}>{isAdmin ? <ProjectSettings project={p} refresh={project.reload} onDelete={() => setDeleting(true)} /> : null}</WorkspaceSettings>}
          />
        </Routes>
      </Suspense>
      {deleting ? (
        <Confirm
          title="Delete workspace?"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/enterprise/api/projects/${p.id}`, {
              method: "DELETE",
            });
            navigate(`${orgBase}/workspaces`);
          }}
        >
          This removes the workspace and revokes its members’ access. Save any
          files you need before continuing.
        </Confirm>
      ) : null}
    </section>
  );
}
function ProjectSettings({
  project,
  refresh,
  onDelete,
}: {
  project: Project;
  refresh: () => void;
  onDelete: () => void;
}) {
  return (
    <section className="subpage settings-page">

      <Card title="General">
        <ProjectForm
          project={project}
          onCancel={() => window.history.back()}
          onSave={async (body) => {
            await send(`/enterprise/api/projects/${project.id}`, body, "PATCH");
            refresh();
            workspaceChanged();
          }}
        />
      </Card>
      <Card
        title="Delete workspace"
        detail="Removes the workspace and revokes its members’ access. Deleted workspaces can be restored for 30 days."
      >
        <div className="card-actions">
          <button type="button" className="destructive" onClick={onDelete}>
            <Icon icon={Trash2} size={14} />
            Delete workspace
          </button>
        </div>
      </Card>
    </section>
  );
}
type Member = User & {
  access: "read" | "write";
  createdAt: string;
};
export function ProjectMembers({ project }: { project: Project }) {
  const { org, isAdmin } = useWorkspace();
  const members = useResource<List<Member>>(
    `/enterprise/api/projects/${project.id}/members`,
  );
  const people = useResource<List<User>>(
    isAdmin ? `/enterprise/api/organizations/${org.id}/members` : null,
  );
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member>();
  return (
    <section className="subpage">
      <PageHeader
        title="Workspace members"
        description="Every member can use all workspace content and conversations."
        actions={
          isAdmin ? (
            <button className="primary" onClick={() => setAdding(true)}>
              <Icon icon={Plus} size={14} weight="control" />
              Add member
            </button>
          ) : null
        }
      />
      <ErrorNotice message={members.error} onRetry={members.error ? members.reload : undefined} />
      {members.loading && !members.data ? (
        <Loading />
      ) : members.error && !members.data ? null : (
        <div className="table-wrap">
          {members.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  {isAdmin ? (
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {members.data.items.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.email}</td>
                    {isAdmin ? (
                      <td>
                        <button
                          className="text-button danger"
                          onClick={() => setRemoving(m)}
                        >
                          Remove
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No workspace members">
              Add people from your organization to work in this workspace.
            </Empty>
          )}
        </div>
      )}
      {adding ? (
        <Modal title="Add workspace member" onClose={() => setAdding(false)}>
          <AsyncForm
            submitLabel="Add member"
            onCancel={() => setAdding(false)}
            onSubmit={async (d) => {
              await send(`/enterprise/api/projects/${project.id}/members`, {
                userId: d.get("userId"),
                access: "write",
              });
              members.reload();
              setAdding(false);
            }}
          >
            <Field label="Person">
              <select name="userId" required defaultValue="">
                <option value="" disabled>
                  Select a member
                </option>
                {people.data?.items
                  .filter(
                    (u) =>
                      u.enabled &&
                      !members.data?.items.some((m) => m.id === u.id),
                  )
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email}
                    </option>
                  ))}
              </select>
            </Field>
            <ErrorNotice message={people.error} />
          </AsyncForm>
        </Modal>
      ) : null}
      {removing ? (
        <Confirm
          title="Remove workspace member?"
          label="Remove member"
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await api(
              `/enterprise/api/projects/${project.id}/members/${removing.id}`,
              {
                method: "DELETE",
              },
            );
            members.reload();
            setRemoving(undefined);
          }}
        >
          {removing.name || removing.email} will lose access to this workspace and
          its conversations.
        </Confirm>
      ) : null}
    </section>
  );
}
export function MembersPage({ nested = false }: { nested?: boolean }) {
  const { org, user, orgBase } = useWorkspace();
  const members = useResource<List<Member>>(
    `/enterprise/api/organizations/${org.id}/members`,
  );
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<Member>();
  const [remove, setRemove] = useState<Member>();
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState("");
  const [activationUrl, setActivationUrl] = useState("");
  async function sendReset(member: Member) {
    setSuccess("");
    setError("");
    setResetting(member.id);
    try {
      const result = await send<{
        message: string;
      }>(
        `/enterprise/api/organizations/${org.id}/members/${member.id}/password-reset`,
        {},
      );
      setSuccess(result.message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setResetting("");
    }
  }
  return (
    <section>
      {nested ? (
        <BackLink
          to={`${orgBase}/settings`}
          label="Back to organization settings"
        />
      ) : null}
      <PageHeader
        title="Members"
        description="Manage the people who can work in your organization."
        actions={
          <button className="primary" onClick={() => setInvite(true)}>
            <Icon icon={Plus} size={14} weight="control" />
            Invite member
          </button>
        }
      />
      {success ? <Success>{success}</Success> : null}
      {activationUrl ? (
        <div className="share-result">
          <strong>Invitation link</strong>
          <p className="muted">
            Copy this link to share directly with the invitee. It is shown only
            once.
          </p>
          <input
            readOnly
            value={activationUrl}
            aria-label="Invitation link"
            onFocus={(e) => e.target.select()}
          />
        </div>
      ) : null}
      <ErrorNotice message={members.error || error} onRetry={members.error ? members.reload : undefined} />
      {members.loading && !members.data ? (
        <Loading />
      ) : members.error && !members.data ? null : (
        <div className="table-wrap">
          {members.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data.items.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name || "Invited member"}</td>
                    <td>{m.email}</td>
                    <td className="capitalize">{m.role}</td>
                    <td>
                      <Status
                        value={
                          m.invitationPending
                            ? "invited"
                            : !m.enabled
                              ? "disabled"
                              : "active"
                        }
                      />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="text-button"
                          onClick={() => setEdit(m)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button"
                          disabled={
                            !m.enabled ||
                            m.invitationPending ||
                            resetting === m.id
                          }
                          onClick={() => void sendReset(m)}
                        >
                          {resetting === m.id
                            ? "Sending…"
                            : "Send password reset"}
                        </button>
                        {m.id !== user.id ? (
                          <button
                            className="text-button danger"
                            onClick={() => setRemove(m)}
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No members yet">
              Invite the first person to this organization.
            </Empty>
          )}
        </div>
      )}
      {invite ? (
        <Modal title="Invite member" onClose={() => setInvite(false)}>
          <AsyncForm
            submitLabel="Send invitation"
            onCancel={() => setInvite(false)}
            onSubmit={async (d) => {
              const result = await send<{
                activationUrl?: string;
                invitation?: {
                  expiresAt: string;
                };
              }>(`/enterprise/api/organizations/${org.id}/invitations`, {
                email: d.get("email"),
                name: d.get("name"),
                role: d.get("role"),
              });
              members.reload();
              setInvite(false);
              setActivationUrl(result.activationUrl ?? "");
              setSuccess(
                result.invitation
                  ? `Invitation created. Expires ${date(result.invitation.expiresAt)}. Email delivery runs separately when configured.`
                  : "Member added to this organization.",
              );
            }}
          >
            <Field label="Name">
              <input name="name" required maxLength={160} />
            </Field>
            <Field label="Email">
              <input name="email" type="email" required />
            </Field>
            <Field label="Role">
              <select name="role">
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
          </AsyncForm>
        </Modal>
      ) : null}
      {edit ? (
        <Modal title="Edit member" onClose={() => setEdit(undefined)}>
          <AsyncForm
            onCancel={() => setEdit(undefined)}
            onSubmit={async (d) => {
              await send(
                `/enterprise/api/organizations/${org.id}/members/${edit.id}`,
                {
                  role: d.get("role"),
                    enabled: d.get("enabled") === "on",
                },
                "PATCH",
              );
              members.reload();
              setEdit(undefined);
            }}
          >
            <Field label="Name">
              <input value={edit.name} readOnly />
            </Field>
            <Field label="Role">
              <select name="role" defaultValue={edit.role}>
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
            <Switch name="enabled" defaultChecked={edit.enabled}>
              Organization membership enabled
            </Switch>
          </AsyncForm>
        </Modal>
      ) : null}
      {remove ? (
        <Confirm
          title="Remove member?"
          label="Remove member"
          onClose={() => setRemove(undefined)}
          onConfirm={async () => {
            await api(
              `/enterprise/api/organizations/${org.id}/members/${remove.id}`,
              {
                method: "DELETE",
              },
            );
            members.reload();
            setRemove(undefined);
          }}
        >
          This removes {remove.email} from this organization and its projects.
          Their account and other organization memberships remain available.
        </Confirm>
      ) : null}
    </section>
  );
}
export function SettingsPage() {
  const { user, org, refreshOrganizations, orgBase } = useWorkspace();
  const hosts = useResource<
    List<{
      id: string;
      name: string;
    }>
  >(user.role === "owner" ? "/enterprise/api/hosts" : null);
  const [saved, setSaved] = useState(false);
  return (
    <section className="organization-settings settings-page">
      <PageHeader title="Organization settings" />
      <Card title="General">
        <AsyncForm
          key={org.id}
          onSubmit={async (d) => {
            await send(
              `/enterprise/api/organizations/${org.id}`,
              {
                name: d.get("name"),
                ...(user.role === "owner" && d.has("defaultHostId")
                  ? {
                      defaultHostId: d.get("defaultHostId"),
                    }
                  : {}),
              },
              "PATCH",
            );
            refreshOrganizations();
            setSaved(true);
          }}
        >
          {user.role === "owner" ? (
            <>
              <ErrorNotice message={hosts.error} />
              <Field
                label="Default workspace host"
                hint="Applies to new workspaces. Existing workspaces retain their host."
              >
                <select
                  name="defaultHostId"
                  defaultValue={org.defaultHostId}
                  disabled={hosts.loading}
                  required
                >
                  {hosts.data?.items.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : null}
          <Field label="Organization name">
            <input
              name="name"
              defaultValue={org.name}
              required
              maxLength={160}
            />
          </Field>
        </AsyncForm>
        {saved ? <Success>Organization updated.</Success> : null}
      </Card>
      <Card title="Management">
        <div className="destination-list">
          <DestinationRow
            to={`${orgBase}/settings/deleted-workspaces`}
            icon={Trash2}
            title="Deleted workspaces"
            detail="Restore workspaces or recover files within 30 days."
          />
          <DestinationRow
            to={`${orgBase}/members`}
            icon={Users}
            title="Members"
            detail="Invite people, update roles, and send password resets."
          />
          <DestinationRow
            to={`${orgBase}/connections`}
            icon={Cable}
            title="Connections"
            detail="Manage inference accounts available to the organization."
          />
        </div>
      </Card>
    </section>
  );
}
