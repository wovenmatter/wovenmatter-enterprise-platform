import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Check, Folder } from "lucide-react";
import {
  api,
  errorMessage,
  send,
  useResource,
  type Organization,
  type User,
} from "../api";
import { safeContentUrl } from "../conversation-state";
import { Icon } from "../components/controls";
import { sidebarStyles, useSidebar } from "../shell/sidebar-preferences";
import {
  AsyncForm,
  BackLink,
  Card,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageHeader,
  Success,
} from "../components/ui";

const themes = [
  ["green", "Green"],
  ["cognac", "Cognac"],
  ["dark", "Dark"],
] as const;

export function PersonalSettings({
  user,
  onUserChange,
}: {
  user: User;
  onUserChange: (user: User) => void;
}) {
  const sidebar = useSidebar();
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
    <section className="personal-settings settings-page">
      {returnTo ? <BackLink to={returnTo} label="Back to organization" /> : null}
      <PageHeader
        title="Personal settings"
        description="Manage your profile and preferences."
      />
      {profile.loading ? <Loading /> : null}
      <ErrorNotice message={profile.error} onRetry={profile.reload} />
      <AsyncForm
        key={`${current.id}:${current.name}:${current.theme}:${current.defaultModel ?? ""}`}
        className="settings-form"
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
        <Card title="Profile">
          <Field label="Display name">
            <input
              name="name"
              required
              maxLength={160}
              defaultValue={current.name}
            />
          </Field>
          <Field
            label="Default model"
            hint="New sessions use this model when it is available. You can switch models in the conversation."
          >
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
          </Field>
          <ErrorNotice message={modelsError} />
        </Card>
        <Card
          title="Appearance"
          detail="Your theme applies across organizations when you save your profile."
        >
          <fieldset className="theme-choices">
            <legend className="sr-only">Theme</legend>
            {themes.map(([value, title]) => (
              <label className="theme-choice" key={value}>
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  defaultChecked={current.theme === value}
                />
                <span className="theme-preview" data-preview={value} aria-hidden="true">
                  <span className="theme-preview-rail" />
                  <span className="theme-preview-pane">
                    <span className="theme-preview-primary" />
                    <span className="theme-preview-line" />
                  </span>
                  <span className="theme-preview-rail" />
                </span>
                <span className="theme-choice-label">
                  <span>
                    {title}
                    <span className="sr-only"> theme</span>
                  </span>
                  <Icon icon={Check} size={12} weight="search" className="theme-check" />
                </span>
              </label>
            ))}
          </fieldset>
        </Card>
      </AsyncForm>
      {saved ? <Success>{saved}</Success> : null}
      <Card title="Sidebar layout" detail="Applies immediately for your account in this browser. These device-local preferences are not synchronized to other browsers or devices.">
        <fieldset className="sidebar-style-choices">
          <legend className="sr-only">Sidebar layout</legend>
          {sidebarStyles.map(style => <label key={style.value} className="sidebar-style-choice">
            <input type="radio" name="sidebar-layout" value={style.value} checked={sidebar.preferences.style === style.value} onChange={() => sidebar.update({ style: style.value })} />
            <span><strong>{style.title}</strong><small>{style.detail}</small></span>
          </label>)}
        </fieldset>
        {sidebar.preferences.style !== "split" ? <Field label="Sidebar side" hint="You can also move the sidebar using its header control."><select value={sidebar.preferences.side} onChange={event => sidebar.update({ side: event.target.value === "right" ? "right" : "left" })}><option value="left">Left</option><option value="right">Right</option></select></Field> : null}
        {sidebar.storageError ? <ErrorNotice message="Browser storage is unavailable. This layout works for this session, but cannot be saved for your next visit." /> : null}
      </Card>
      <Card title="Account">
        <div className="value-row">
          <span>Email</span>
          <strong>{current.email}</strong>
        </div>
        <div className="value-row">
          <span>Role</span>
          <strong className="capitalize">
            {current.role === "owner" ? "Platform owner" : current.role}
          </strong>
        </div>
      </Card>
      <Card
        title="Password"
        detail="Request a private reset link at your account email."
      >
        <div className="card-actions">
          <button
            type="button"
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
        </div>
        <ErrorNotice message={resetError} />
        {reset ? <Success>{reset}</Success> : null}
      </Card>
      <Card title="Accessible organizations">
        {organizations.length ? (
          <div className="table-wrap">
            <table>
              <tbody>
                {organizations.map((org) => (
                  <tr key={org.id}>
                    <td>
                      <Link
                        className="item-link"
                        to={`/organizations/${org.id}/workspaces`}
                      >
                        <Icon icon={Folder} size={16} />
                        <strong>{org.name}</strong>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !profile.loading && !profile.error ? (
          <Empty title="No organization access">
            Your account has no organization access.
          </Empty>
        ) : null}
      </Card>
      <Card title="Accessible workspaces">
        {projects.length ? (
          <div className="table-wrap">
            <table>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td>
                      <Link
                        className="item-link"
                        to={`/organizations/${project.orgId}/workspaces/${project.id}`}
                      >
                        <Icon icon={Folder} size={16} />
                        <div>
                          <strong>{project.name}</strong>
                          <small>{project.organizationName}</small>
                        </div>
                      </Link>
                    </td>
                    <td>
                      Member
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !profile.loading && !profile.error ? (
          <Empty title="No workspace access">
            Workspaces you can open will appear here.
          </Empty>
        ) : null}
      </Card>
    </section>
  );
}
