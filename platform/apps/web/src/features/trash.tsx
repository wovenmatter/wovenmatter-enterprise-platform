import { useState } from "react";
import { send, useResource, date, type List } from "../api";
import { useWorkspace } from "../workspace";
import {
  BackLink,
  Empty,
  ErrorNotice,
  Loading,
  PageHeader,
  Success,
} from "../components/ui";
type Deleted = {
  id: string;
  name: string;
  deletedAt: string;
  purgeAfter: string;
  status: string;
};
export function DeletedProjectsPage() {
  const { org, orgBase } = useWorkspace();
  const resource = useResource<List<Deleted>>(
    `/enterprise/api/organizations/${org.id}/deleted-projects`,
  );
  const [busy, setBusy] = useState<string>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function action(
    project: Deleted,
    operation: "restore" | "recover-files",
  ) {
    setBusy(project.id);
    setError("");
    setNotice("");
    try {
      const result = await send<{
        path?: string;
      }>(`/enterprise/api/deleted-projects/${project.id}/${operation}`, {});
      setNotice(
        result.path
          ? `Files recovered to Library / ${result.path}`
          : "Workspace restored.",
      );
      resource.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recovery failed.");
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <section className="settings-nested">
      <BackLink
        to={`${orgBase}/settings`}
        label="Back to organization settings"
      />
      <PageHeader
        title="Deleted workspaces"
        description="Restore workspaces or recover their files within 30 days of deletion."
      />
      <ErrorNotice
        message={error || resource.error}
        onRetry={resource.error ? resource.reload : undefined}
      />
      {notice ? <Success>{notice}</Success> : null}
      {resource.loading && !resource.data ? (
        <Loading />
      ) : resource.error && !resource.data ? null : resource.data?.items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Deleted</th>
                <th>Recover until</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.items.map((project) => (
                <tr key={project.id}>
                  <td>{project.name}</td>
                  <td>{date(project.deletedAt)}</td>
                  <td>{date(project.purgeAfter)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="secondary"
                        disabled={
                          !!busy || Date.parse(project.purgeAfter) <= Date.now()
                        }
                        onClick={() => void action(project, "restore")}
                      >
                        {busy === project.id ? "Working…" : "Restore"}
                      </button>
                      <button
                        className="secondary"
                        disabled={
                          !!busy || Date.parse(project.purgeAfter) <= Date.now()
                        }
                        onClick={() => void action(project, "recover-files")}
                      >
                        Recover files to library
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No deleted workspaces">
          Deleted workspaces remain recoverable here for 30 days.
        </Empty>
      )}
    </section>
  );
}
