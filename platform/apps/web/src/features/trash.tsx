import { useState } from "react";
import { send, useResource, date, type List } from "../api";
import { useWorkspace } from "../workspace";
import {
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
  const { org } = useWorkspace();
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
          : "Project restored.",
      );
      resource.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recovery failed.");
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <section>
      <PageHeader
        title="Deleted projects"
        description="Restore projects or recover their files within 30 days of deletion."
      />
      <ErrorNotice message={error || resource.error} />
      {notice ? <Success>{notice}</Success> : null}
      {resource.loading ? (
        <Loading />
      ) : resource.data?.items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Project</th>
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
                        disabled={
                          !!busy || Date.parse(project.purgeAfter) <= Date.now()
                        }
                        onClick={() => void action(project, "restore")}
                      >
                        {busy === project.id ? "Working…" : "Restore"}
                      </button>
                      <button
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
        <Empty title="No deleted projects">
          Deleted projects remain recoverable here for 30 days.
        </Empty>
      )}
    </section>
  );
}
