import { lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ArrowLeft,
  Cable,
  ChevronRight,
  Folder,
  PanelLeftClose,
  Plus,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
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
import {
  AsyncForm,
  Confirm,
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
  import("./files").then((m) => ({ default: m.FilesPage })),
);
const ConversationsPage = lazy(() =>
  import("./conversations").then((m) => ({ default: m.ConversationsPage })),
);

export function ProjectsPage() {
  const { org, isAdmin, orgBase } = useWorkspace();
  const projects = useResource<List<Project>>(
    `/api/organizations/${org.id}/projects`,
  );
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  return (
    <section>
      <PageHeader
        title="Projects"
        actions={
          isAdmin ? (
            <button className="primary" onClick={() => setCreating(true)}>
              <Plus size={17} />
              New project
            </button>
          ) : null
        }
      />
      <ErrorNotice message={projects.error} />
      {projects.loading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          {projects.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {projects.data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link className="item-link" to={`${orgBase}/projects/${p.id}`}>
                      <Folder size={20} />
                      <div>
                        <strong>{p.name}</strong>
                        {p.description ? <small>{p.description}</small> : null}
                      </div>
                    </Link>
                  </td>
                  <td>{p.access === "write" ? "Read & write" : "Read only"}</td>
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
              title="No projects yet"
              action={
                isAdmin ? (
                  <button className="primary" onClick={() => setCreating(true)}>
                    Create project
                  </button>
                ) : null
              }
            >
              {isAdmin
                ? "Create a project to bring your team, files, and conversations together."
                : "Your administrator can add you to a project."}
            </Empty>
          )}
        </div>
      )}
      {creating ? (
        <Modal title="New project" onClose={() => setCreating(false)}>
          <ProjectForm
            onCancel={() => setCreating(false)}
            onSave={async (body) => {
              const p = await send<Project>(
                `/api/organizations/${org.id}/projects`,
                body,
              );
              setCreating(false);
              projects.reload();
              navigate(`${orgBase}/projects/${p.id}`);
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
  return (
    <AsyncForm
      submitLabel={project ? "Save changes" : "Create project"}
      onCancel={onCancel}
      onSubmit={async (data) =>
        onSave({
          name: data.get("name"),
          description: data.get("description"),
          access: data.get("access"),
        })
      }
    >
      <Field label="Project name">
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
      <Field
        label="Project access"
        hint="Individual members may have more limited permissions."
      >
        <select name="access" defaultValue={project?.access ?? "write"}>
          <option value="write">Read & write</option>
          <option value="read">Read only</option>
        </select>
      </Field>
    </AsyncForm>
  );
}
export function ProjectPage() {
  const { projectId } = useParams();
  const { isAdmin, org, orgBase, selectOrganization } = useWorkspace();
  const project = useResource<Project>(
    projectId ? `/api/projects/${projectId}` : null,
  );
  const [editing, setEditing] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
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
    return <ErrorNotice message={project.error || "Project unavailable."} />;
  const p = project.data;
  return (
    <section className="project-page">
      <Link to={`${orgBase}/projects`} className="breadcrumb">
        <ArrowLeft size={15} />
        Projects
      </Link>
      <PageHeader
        title={p.name}
        description={p.description}
        actions={
          isAdmin ? (
            <>
              <button className="secondary" onClick={() => setEditing(true)}>
                <Settings size={16} />
                Project settings
              </button>
              <button
                className="icon-button danger"
                aria-label="Delete project"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={17} />
              </button>
            </>
          ) : null
        }
      />
      {p.status !== "ready" && p.status !== "active" ? (
        <div className="notice">
          <Status value={p.status} />
          <span>Project setup is managed in the background.</span>
          <button className="text-button" onClick={project.reload}>
            Refresh status
          </button>
          {isAdmin && p.status === "needs_attention" ? (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await send(`/api/projects/${p.id}/retry`, {});
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
      <nav className="tabs" aria-label="Project views">
        <NavLink end to={`${orgBase}/projects/${p.id}`}>
          Conversations
        </NavLink>
        <NavLink to={`${orgBase}/projects/${p.id}/files`}>Files</NavLink>
        <NavLink to={`${orgBase}/projects/${p.id}/members`}>Members</NavLink>
      </nav>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route index element={<ConversationsPage key={p.id} project={p} />} />
          <Route path="files" element={<FilesPage key={p.id} project={p} />} />
          <Route path="members" element={<ProjectMembers project={p} />} />
        </Routes>
      </Suspense>
      {editing ? (
        <Modal title="Project settings" onClose={() => setEditing(false)}>
          <ProjectForm
            project={p}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              await send(`/api/projects/${p.id}`, body, "PATCH");
              setEditing(false);
              project.reload();
            }}
          />
        </Modal>
      ) : null}
      {deleting ? (
        <Confirm
          title="Delete project?"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/api/projects/${p.id}`, { method: "DELETE" });
            navigate(`${orgBase}/projects`);
          }}
        >
          This removes the project and revokes its members’ access. Save any
          files you need before continuing.
        </Confirm>
      ) : null}
    </section>
  );
}
type Member = User & { access: "read" | "write"; createdAt: string };
export function ProjectMembers({ project }: { project: Project }) {
  const { org, isAdmin } = useWorkspace();
  const members = useResource<List<Member>>(
    `/api/projects/${project.id}/members`,
  );
  const people = useResource<List<User>>(
    isAdmin ? `/api/organizations/${org.id}/members` : null,
  );
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member>();
  const [error, setError] = useState("");
  return (
    <section className="subpage">
      <PageHeader
        title="Project members"
        actions={
          isAdmin ? (
            <button className="primary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add member
            </button>
          ) : null
        }
      />
      <ErrorNotice message={members.error || error} />
      {members.loading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          {members.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Access</th>
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
                  <td>
                    {isAdmin ? (
                      <select
                        aria-label={`Access for ${m.name}`}
                        value={m.access}
                        onChange={async (e) => {
                          setError("");
                          try {
                            await send(
                              `/api/projects/${project.id}/members/${m.id}`,
                              { access: e.target.value },
                              "PATCH",
                            );
                            members.reload();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <option value="read">Read only</option>
                        <option value="write">Read & write</option>
                      </select>
                    ) : m.access === "write" ? (
                      "Read & write"
                    ) : (
                      "Read only"
                    )}
                  </td>
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
            <Empty title="No project members">
              Add people from your organization to work in this project.
            </Empty>
          )}
        </div>
      )}
      {adding ? (
        <Modal title="Add project member" onClose={() => setAdding(false)}>
          <AsyncForm
            submitLabel="Add member"
            onCancel={() => setAdding(false)}
            onSubmit={async (d) => {
              await send(`/api/projects/${project.id}/members`, {
                userId: d.get("userId"),
                access: d.get("access"),
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
            <Field label="Access">
              <select name="access">
                <option value="read">Read only</option>
                <option value="write">Read & write</option>
              </select>
            </Field>
            <ErrorNotice message={people.error} />
          </AsyncForm>
        </Modal>
      ) : null}
      {removing ? (
        <Confirm
          title="Remove project member?"
          label="Remove member"
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await api(`/api/projects/${project.id}/members/${removing.id}`, {
              method: "DELETE",
            });
            members.reload();
            setRemoving(undefined);
          }}
        >
          {removing.name || removing.email} will lose access to this project and
          its conversations.
        </Confirm>
      ) : null}
    </section>
  );
}
export function MembersPage({ nested = false }: { nested?: boolean }) {
  const { org, user, orgBase } = useWorkspace();
  const members = useResource<List<Member>>(
    `/api/organizations/${org.id}/members`,
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
      const result = await send<{ message: string }>(
        `/api/organizations/${org.id}/members/${member.id}/password-reset`,
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
        <Link
          to={`${orgBase}/settings`}
          className="icon-button settings-back-link"
          aria-label="Back to organization settings"
          title="Back to organization settings"
        >
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </Link>
      ) : null}
      <PageHeader
        title="Members"
        description="Manage the people who can work in your organization."
        actions={
          <button className="primary" onClick={() => setInvite(true)}>
            <Plus size={17} />
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
      <ErrorNotice message={members.error || error} />
      {members.loading ? (
        <Loading />
      ) : (
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
                  <td>{m.role}</td>
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
                        disabled={!m.enabled || m.invitationPending || resetting === m.id}
                        onClick={() => void sendReset(m)}
                      >
                        {resetting === m.id ? "Sending…" : "Send password reset"}
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
                invitation: { expiresAt: string };
              }>(`/api/organizations/${org.id}/invitations`, {
                email: d.get("email"),
                name: d.get("name"),
                role: d.get("role"),
              });
              members.reload();
              setInvite(false);
              setActivationUrl(result.activationUrl ?? "");
              setSuccess(
                `Invitation created. Expires ${date(result.invitation.expiresAt)}. Email delivery runs separately when configured.`,
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
                `/api/organizations/${org.id}/members/${edit.id}`,
                {
                  name: d.get("name"),
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
              <input name="name" defaultValue={edit.name} required />
            </Field>
            <Field label="Role">
              <select name="role" defaultValue={edit.role}>
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={edit.enabled}
              />
              Account enabled
            </label>
          </AsyncForm>
        </Modal>
      ) : null}
      {remove ? (
        <Confirm
          title="Remove member?"
          label="Remove member"
          onClose={() => setRemove(undefined)}
          onConfirm={async () => {
            await api(`/api/organizations/${org.id}/members/${remove.id}`, {
              method: "DELETE",
            });
            members.reload();
            setRemove(undefined);
          }}
        >
          This disables {remove.email} and revokes their organization access.
        </Confirm>
      ) : null}
    </section>
  );
}
export function SettingsPage() {
  const { org, refreshOrganizations, orgBase } = useWorkspace();
  const [saved, setSaved] = useState(false);
  return (
    <section className="organization-settings">
      <PageHeader title="Organization settings" />
      <div className="settings-form">
        <AsyncForm
          key={org.id}
          onSubmit={async (d) => {
            await send(
              `/api/organizations/${org.id}`,
              { name: d.get("name") },
              "PATCH",
            );
            refreshOrganizations();
            setSaved(true);
          }}
        >
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
      </div>
      <section className="section-block">
        <h2>Management</h2>
        <div className="settings-list">
          <Link className="setting-row setting-link" to={`${orgBase}/settings/members`}>
            <Users size={16} />
            <div>
              <strong>Members</strong>
              <small>Invite people, update roles, and send password resets.</small>
            </div>
            <ChevronRight size={11} className="destination-chevron" />
          </Link>
          <Link className="setting-row setting-link" to={`${orgBase}/settings/connections`}>
            <Cable size={16} />
            <div>
              <strong>Connections</strong>
              <small>Manage inference accounts available to the organization.</small>
            </div>
            <ChevronRight size={11} className="destination-chevron" />
          </Link>
        </div>
      </section>
    </section>
  );
}
