import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Folder, PanelLeftClose } from "lucide-react";
import {
  api,
  errorMessage,
  send,
  useResource,
  type Organization,
  type User,
} from "../api";
import { safeContentUrl } from "../conversation-state";
import {
  AsyncForm,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageHeader,
  Success,
} from "../components/ui";

export function PersonalSettings({
  user,
  onUserChange,
}: {
  user: User;
  onUserChange: (user: User) => void;
}) {
  const profile = useResource<{
    user: User;
    organizations: Organization[];
    projects: Array<{
      id: string;
      orgId: string;
      organizationName: string;
      name: string;
      access: "read" | "write";
      status: string;
    }>;
  }>("/enterprise/api/me");
  const [saved, setSaved] = useState("");
  const [reset, setReset] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetPending, setResetPending] = useState(false);
  const current = profile.data?.user ?? user;
  const organizations = profile.data?.organizations ?? [];
  const projects = profile.data?.projects ?? [];
  const organizationIds = organizations.map((org) => org.id).join(",");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsError, setModelsError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setModelsError("");
    const ids = organizationIds ? organizationIds.split(",") : [];
    void Promise.allSettled(
      ids.map((id) =>
        api<{ items: Array<{ id: string; name: string }> }>(
          "/enterprise/api/organizations/" + id + "/inference/models",
          { signal: controller.signal },
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const available = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value.items : [],
      );
      setModels([
        ...new Map(available.map((model) => [model.id, model])).values(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        setModelsError("Some organization models could not be loaded.");
    });
    return () => controller.abort();
  }, [organizationIds]);
  const location = useLocation();
  const requestedReturn = new URLSearchParams(location.search).get("returnTo");
  const returnTo = requestedReturn?.startsWith("/organizations/")
    ? safeContentUrl(requestedReturn)
    : undefined;
  return (
    <section className="personal-settings">
      {returnTo ? (
        <Link className="breadcrumb" to={returnTo}>
          <PanelLeftClose size={16} strokeWidth={1.75} />
          Back to organization
        </Link>
      ) : null}
      <PageHeader
        title="Personal settings"
        description="Manage your profile and preferences."
      />
      {profile.loading ? <Loading /> : null}
      <ErrorNotice message={profile.error} />
      <div className="settings-form">
        <AsyncForm
          key={`${current.id}:${current.name}:${current.theme}:${current.defaultModel ?? ""}`}
          submitLabel="Save profile"
          onSubmit={async (data) => {
            const updated = await send<User>(
              "/enterprise/api/me",
              {
                name: data.get("name"),
                theme: data.get("theme"),
                defaultModel: data.get("defaultModel") || null,
              },
              "PATCH",
            );
            onUserChange(updated);
            profile.reload();
            setSaved("Profile updated.");
          }}
        >
          <Field label="Display name">
            <input
              name="name"
              required
              maxLength={160}
              defaultValue={current.name}
            />
          </Field>
          <Field label="Default model">
            <select
              name="defaultModel"
              defaultValue={current.defaultModel ?? ""}
            >
              <option value="">First available model</option>
              {current.defaultModel &&
              !models.some((model) => model.id === current.defaultModel) ? (
                <option value={current.defaultModel}>
                  {current.defaultModel} (unavailable)
                </option>
              ) : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <small>
              New sessions use this model when it is available. You can switch
              models in the conversation.
            </small>
          </Field>
          <ErrorNotice message={modelsError} />
          <Field label="Theme">
            <select name="theme" defaultValue={current.theme}>
              <option value="green">Green</option>
              <option value="cognac">Cognac</option>
            </select>
          </Field>
        </AsyncForm>
        {saved ? <Success>{saved}</Success> : null}
      </div>
      <section className="section-block">
        <h2>Profile</h2>
        <div className="settings-list">
          <div className="setting-row">
            <div>
              <strong>Email</strong>
              <small>{current.email}</small>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>Role</strong>
              <small>
                {current.role === "owner" ? "Platform owner" : current.role}
              </small>
            </div>
          </div>
        </div>
      </section>
      <section className="section-block">
        <h2>Password</h2>
        <button
          className="secondary"
          disabled={resetPending || Boolean(profile.error)}
          onClick={async () => {
            setReset("");
            setResetError("");
            setResetPending(true);
            try {
              const result = await send<{ message: string }>(
                "/enterprise/api/password-reset/request",
                { email: current.email },
              );
              setReset(result.message);
            } catch (error) {
              setResetError(errorMessage(error));
            } finally {
              setResetPending(false);
            }
          }}
        >
          {resetPending ? "Requesting…" : "Request password reset"}
        </button>
        <ErrorNotice message={resetError} />
        {reset ? <Success>{reset}</Success> : null}
      </section>
      <section className="section-block">
        <h2>Accessible organizations</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              {organizations.map((org) => (
                <tr key={org.id}>
                  <td>
                    <Link
                      className="item-link"
                      to={`/organizations/${org.id}/projects`}
                    >
                      <Folder size={18} />
                      <strong>{org.name}</strong>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!profile.loading && !profile.error && !organizations.length ? (
            <Empty title="No organization access">
              Your account has no organization access.
            </Empty>
          ) : null}
        </div>
      </section>
      <section className="section-block">
        <h2>Accessible projects</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link
                      className="item-link"
                      to={`/organizations/${project.orgId}/projects/${project.id}`}
                    >
                      <Folder size={18} />
                      <div>
                        <strong>{project.name}</strong>
                        <small>{project.organizationName}</small>
                      </div>
                    </Link>
                  </td>
                  <td>
                    {project.access === "write" ? "Full access" : "Read-only"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!profile.loading && !profile.error && !projects.length ? (
            <Empty title="No project access">
              Projects you can open will appear here.
            </Empty>
          ) : null}
        </div>
      </section>
    </section>
  );
}
