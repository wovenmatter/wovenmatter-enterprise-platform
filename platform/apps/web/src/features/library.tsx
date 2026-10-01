import { useState } from "react";
import { Plus, ExternalLink } from "lucide-react";
import { api, send, useResource, type List, type Project } from "../api";
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
} from "../components/ui";
import { FilesPage } from "./files";

type Report = {
  id: string;
  projectId: string;
  createdBy: string;
  name: string;
  visibility: "project" | "organization" | "public";
  url: string;
};

function Visibility({ value = "project" }: { value?: string }) {
  return (
    <Field label="Visibility">
      <select name="visibility" defaultValue={value}>
        <option value="project">Project</option>
        <option value="organization">Organization</option>
        <option value="public">Public</option>
      </select>
    </Field>
  );
}

export function LibraryPage() {
  const { org, user, isAdmin } = useWorkspace();
  const assets = useResource<List<Report>>(
    `/enterprise/api/organizations/${org.id}/assets`,
  );
  const projects = useResource<List<Project>>(
    `/enterprise/api/organizations/${org.id}/projects`,
  );
  const [view, setView] = useState<"files" | "reports">("files");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Report>();
  const [removing, setRemoving] = useState<Report>();
  const writable =
    projects.data?.items.filter((project) => project.access === "write") ?? [];

  return (
    <section className="library-page">
      <PageHeader
        title="Library"
        description="Organization files and shared reports."
        actions={
          <div className="tabs" role="group" aria-label="Library view">
            <button
              aria-pressed={view === "files"}
              onClick={() => setView("files")}
            >
              Files
            </button>
            <button
              aria-pressed={view === "reports"}
              onClick={() => setView("reports")}
            >
              Reports
            </button>
          </div>
        }
      />
      <div hidden={view !== "files"}>
        <FilesPage embedded />
      </div>
      {view === "reports" ? (
        <>
          <div className="section-heading-row">
            <h2>Reports</h2>
            {writable.length > 0 ? (
              <button className="primary" onClick={() => setCreating(true)}>
                <Plus size={16} />
                Publish report
              </button>
            ) : null}
          </div>
          <ErrorNotice message={assets.error || projects.error} />
          {assets.loading ? (
            <Loading />
          ) : assets.data?.items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Visibility</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.data.items.map((report) => (
                    <tr key={report.id}>
                      <td>
                        <a href={report.url} target="_blank" rel="noreferrer">
                          {report.name} <ExternalLink size={14} />
                        </a>
                      </td>
                      <td>{report.visibility}</td>
                      <td>
                        {isAdmin || report.createdBy === user.id ? (
                          <div className="row-actions">
                            <button onClick={() => setSelected(report)}>
                              Change visibility
                            </button>
                            <button
                              className="text-button danger"
                              onClick={() => setRemoving(report)}
                            >
                              Remove
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No reports yet">
              Ask your agent to prepare a report file, then publish it here.
              Data updates when the report is opened or refreshed.
            </Empty>
          )}
        </>
      ) : null}
      {creating ? (
        <PublishReport
          projects={writable}
          onClose={() => setCreating(false)}
          onSaved={() => {
            assets.reload();
            setCreating(false);
            setView("reports");
          }}
        />
      ) : null}
      {selected ? (
        <Modal title="Report visibility" onClose={() => setSelected(undefined)}>
          <AsyncForm
            onCancel={() => setSelected(undefined)}
            onSubmit={async (data) => {
              await send(
                `/enterprise/api/assets/${selected.id}`,
                { visibility: data.get("visibility") },
                "PATCH",
              );
              assets.reload();
              setSelected(undefined);
            }}
          >
            <Visibility value={selected.visibility} />
            <p>Public reports can be viewed without signing in.</p>
          </AsyncForm>
        </Modal>
      ) : null}
      {removing ? (
        <Confirm
          title="Remove report?"
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await api(`/enterprise/api/assets/${removing.id}`, {
              method: "DELETE",
            });
            assets.reload();
            setRemoving(undefined);
          }}
        >
          The report link will stop working immediately.
        </Confirm>
      ) : null}
    </section>
  );
}

function PublishReport({
  projects,
  onClose,
  onSaved,
}: {
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { org } = useWorkspace();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const files = useResource<
    List<{ id: string; name: string; path: string; kind: string }>
  >(
    projectId
      ? `/enterprise/api/files?orgId=${org.id}&projectId=${projectId}`
      : null,
  );
  return (
    <Modal title="Publish report" onClose={onClose}>
      <AsyncForm
        submitLabel="Publish report"
        onCancel={onClose}
        onSubmit={async (data) => {
          await send(`/enterprise/api/organizations/${org.id}/assets`, {
            projectId,
            name: data.get("name"),
            visibility: data.get("visibility"),
            sourceFileId: data.get("sourceFileId"),
          });
          onSaved();
        }}
      >
        <Field label="Name">
          <input name="name" required maxLength={200} />
        </Field>
        <Field label="Project">
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Report file">
          <select name="sourceFileId" required defaultValue="" key={projectId}>
            <option value="" disabled>
              Select a report file
            </option>
            {files.data?.items
              .filter(
                (file) => file.kind === "file" && file.path.endsWith(".json"),
              )
              .map((file) => (
                <option key={file.id} value={file.id}>
                  {file.path}
                </option>
              ))}
          </select>
        </Field>
        <p className="muted">
          Ask your agent to save a report file in the project’s main folder.
        </p>
        <Visibility />
        <ErrorNotice message={files.error} />
        {files.loading ? <Loading /> : null}
      </AsyncForm>
    </Modal>
  );
}
