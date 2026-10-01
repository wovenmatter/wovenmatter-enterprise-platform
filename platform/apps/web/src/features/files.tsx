import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { sourcePath } from "../source-preview";
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Upload,
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
  Success,
} from "../components/ui";
type FileEntry = {
  id: string;
  name: string;
  path: string;
  kind: "file" | "directory" | "folder";
  size: number;
  updatedAt: string;
  access: "read" | "write";
  orgId: string;
  projectId: string | null;
  needsAttention?: string;
  sharedFrom?: { fileId: string; orgId: string; path: string; access: string };
};
type Share = {
  projectId: string;
  projectName?: string;
  name?: string;
  access: "read" | "write";
};
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const childPath = (path: string, name: string) =>
  [path.replace(/^\/+|\/+$/g, ""), name].filter(Boolean).join("/");
export function FilesPage({
  project,
  embedded = false,
  leadingActions,
}: {
  project?: Project;
  embedded?: boolean;
  leadingActions?: ReactNode;
}) {
  const { org, isAdmin, orgBase } = useWorkspace();
  const [path, setPath] = useState("");
  const query = new URLSearchParams({
    orgId: org.id,
    path,
    ...(project ? { projectId: project.id } : {}),
  });
  const files = useResource<List<FileEntry> & { access: "read" | "write" }>(
    `/api/files?${query}`,
  );
  const projects = useResource<List<Project>>(
    `/api/organizations/${org.id}/projects`,
  );
  const [dialog, setDialog] = useState<
    "folder" | "rename" | "transfer" | "sharing" | "versions" | "grants" | null
  >(null);
  const [selected, setSelected] = useState<FileEntry>();
  const [deleting, setDeleting] = useState<FileEntry>();
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const folderUpload = useRef<HTMLInputElement>(null);
  const canWrite = files.data?.access === "write";
  const suffix = project ? `?projectId=${encodeURIComponent(project.id)}` : "";
  function close() {
    setDialog(null);
    setSelected(undefined);
  }
  async function uploadFiles(list: FileList | null) {
    if (!list?.length) return;
    const pending = Array.from(list);
    setUploading(true);
    setError("");
    setSuccess("");
    let uploaded = 0;
    const errors: string[] = [];
    try {
      const batches: File[][] = [];
      let batch: File[] = [];
      let size = 0;
      for (const file of pending) {
        if (file.size > 64 * 1024 * 1024) {
          errors.push(
            `${file.webkitRelativePath || file.name}: exceeds the 64 MB file limit.`,
          );
          continue;
        }
        if (batch.length >= 100 || size + file.size > 64 * 1024 * 1024) {
          batches.push(batch);
          batch = [];
          size = 0;
        }
        batch.push(file);
        size += file.size;
      }
      if (batch.length) batches.push(batch);
      for (let i = 0; i < batches.length; i++) {
        setUploadProgress(`Uploading batch ${i + 1} of ${batches.length}…`);
        const entries = batches[i];
        const data = new FormData();
        data.set("orgId", org.id);
        if (project) data.set("projectId", project.id);
        data.set("path", path);
        data.set(
          "paths",
          JSON.stringify(entries.map((f) => f.webkitRelativePath || f.name)),
        );
        for (const file of entries) data.append("files", file, file.name);
        const result = await api<{
          items: FileEntry[];
          errors: { path: string; message: string }[];
        }>("/api/files/upload", { method: "POST", body: data });
        uploaded += result.items.length;
        errors.push(...result.errors.map((e) => `${e.path}: ${e.message}`));
      }
      setSuccess(`${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded.`);
      if (errors.length) setError(errors.join(" "));
    } catch (e) {
      setError(
        `${uploaded} files uploaded before upload stopped. ${errorMessage(e)} Review the folder before uploading the remaining files.`,
      );
    } finally {
      files.reload();
      setUploading(false);
      setUploadProgress("");
      if (upload.current) upload.current.value = "";
      if (folderUpload.current) folderUpload.current.value = "";
    }
  }
  const actions = canWrite ? (
    <>
      <button className="secondary" onClick={() => setDialog("folder")}>
        <FolderPlus size={17} />
        New folder
      </button>
      <button
        className="secondary"
        disabled={uploading}
        onClick={() => folderUpload.current?.click()}
      >
        Upload folder
      </button>
      <button
        className="primary"
        disabled={uploading}
        onClick={() => upload.current?.click()}
      >
        <Upload size={17} />
        {uploading ? "Uploading…" : "Upload files"}
      </button>
    </>
  ) : null;
  return (
    <section className={project ? "subpage" : embedded ? "section-block" : ""}>
      {embedded ? (
        <div className="section-heading-row">
          <div>
            <h2>Files</h2>
            <p className="muted">
              Store shared resources and make them available to projects.
            </p>
          </div>
          <div className="actions">{leadingActions}{actions}</div>
        </div>
      ) : (
        <PageHeader
          title={project ? "Project files" : "Organization files"}
          description={
            project
              ? "Files available to this project and its agents."
              : "Store shared resources and make them available to projects."
          }
          actions={actions}
        />
      )}
      <input
        className="sr-only"
        ref={upload}
        type="file"
        multiple
        aria-label="Upload files"
        onChange={(e) => void uploadFiles(e.target.files)}
      />
      <input
        className="sr-only"
        ref={folderUpload}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        aria-label="Upload folder"
        onChange={(e) => void uploadFiles(e.target.files)}
      />
      {!embedded || path ? <div className="file-path">
        <button className="text-button" onClick={() => setPath("")}>
          {project ? project.name : embedded ? "Files" : org.name}
        </button>
        {path
          .split("/")
          .filter(Boolean)
          .map((part, i, parts) => (
            <span key={i}>
              {" "}
              /{" "}
              <button
                className="text-button"
                onClick={() => setPath(parts.slice(0, i + 1).join("/"))}
              >
                {part}
              </button>
            </span>
          ))}
        {path ? (
          <button
            className="icon-button"
            aria-label="Parent folder"
            onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
          >
            <ArrowLeft size={17} />
          </button>
        ) : null}
      </div> : null}
      {uploadProgress ? (
        <p className="muted" role="status">
          {uploadProgress}
        </p>
      ) : null}
      <ErrorNotice message={files.error || error} />
      {success ? <Success>{success}</Success> : null}
      {files.loading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          {files.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Updated</th>
                  <th>Access</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.data.items.map((f) => (
                <tr key={`${f.id}:${f.path}`}>
                  <td>
                    {f.kind === "file" ? (
                      <Link
                        className="item-link"
                        to={`${orgBase}${sourcePath(f.id, { projectId: project?.id })}`}
                      >
                        <FileIcon size={19} />
                        <span>
                          {f.name}
                          {f.sharedFrom ? (
                            <small>Shared with this project</small>
                          ) : null}
                          {f.needsAttention ? (
                            <small className="danger">{f.needsAttention}</small>
                          ) : null}
                        </span>
                      </Link>
                    ) : (
                      <button
                        className="item-link text-button"
                        onClick={() => {
                          setPath(f.path);
                          setSuccess("");
                        }}
                      >
                        <Folder size={20} />
                        <span>
                          {f.name}
                          {f.sharedFrom ? (
                            <small>Shared with this project</small>
                          ) : null}
                          {f.needsAttention ? (
                            <small className="danger">{f.needsAttention}</small>
                          ) : null}
                        </span>
                      </button>
                    )}
                  </td>
                  <td>{f.kind === "file" ? bytes(f.size) : "—"}</td>
                  <td>{date(f.updatedAt)}</td>
                  <td>{f.access === "write" ? "Read & write" : "Read only"}</td>
                  <td>
                    <div className="row-actions">
                      {f.kind === "file" ? (
                        <a
                          className="icon-button"
                          href={`/api/files/${f.id}/content${suffix}`}
                          aria-label={`Download ${f.name}`}
                          download
                        >
                          <Download size={17} />
                        </a>
                      ) : null}
                      <select
                        className="action-select"
                        aria-label={`Actions for ${f.name}`}
                        value=""
                        onChange={(e) => {
                          setSelected(f);
                          const action = e.target.value;
                          if (action === "delete") setDeleting(f);
                          else setDialog(action as typeof dialog);
                        }}
                      >
                        <option value="">Actions</option>
                        {f.access === "write" ? (
                          <option value="rename">Rename</option>
                        ) : null}
                        <option value="transfer">Move or copy</option>
                        {!project && isAdmin ? (
                          <option value="sharing">Share with projects</option>
                        ) : null}
                        {!project && isAdmin ? (
                          <option value="grants">People with access</option>
                        ) : null}
                        {f.kind === "file" ? (
                          <option value="versions">Version history</option>
                        ) : null}
                        {f.access === "write" ? (
                          <option value="delete">Delete</option>
                        ) : null}
                      </select>
                    </div>
                  </td>
                </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="This folder is empty">
              {canWrite
                ? "Upload files or create a folder to get started."
                : "Files shared with you will appear here."}
            </Empty>
          )}
        </div>
      )}
      {dialog === "folder" ? (
        <Modal title="New folder" onClose={close}>
          <AsyncForm
            submitLabel="Create folder"
            onCancel={close}
            onSubmit={async (d) => {
              await send("/api/files/folders", {
                orgId: org.id,
                projectId: project?.id,
                path: childPath(path, String(d.get("name"))),
              });
              files.reload();
              close();
            }}
          >
            <Field label="Folder name">
              <input
                name="name"
                required
                maxLength={255}
                pattern="[^/\\]+"
                autoFocus
              />
            </Field>
          </AsyncForm>
        </Modal>
      ) : null}
      {dialog === "rename" && selected ? (
        <Modal title="Rename" onClose={close}>
          <AsyncForm
            submitLabel="Rename"
            onCancel={close}
            onSubmit={async (d) => {
              await send(
                `/api/files/${selected.id}${suffix}`,
                { name: d.get("name") },
                "PATCH",
              );
              files.reload();
              close();
            }}
          >
            <Field label="Name">
              <input
                name="name"
                defaultValue={selected.name}
                required
                maxLength={255}
                autoFocus
              />
            </Field>
          </AsyncForm>
        </Modal>
      ) : null}
      {dialog === "transfer" && selected ? (
        <Modal title="Move or copy" onClose={close}>
          <AsyncForm
            submitLabel="Transfer"
            onCancel={close}
            onSubmit={async (d) => {
              await send(`/api/files/${selected.id}/transfer${suffix}`, {
                destination: {
                  orgId: org.id,
                  projectId: d.get("destination") || undefined,
                  path: d.get("path") || "",
                },
                operation: d.get("operation"),
              });
              files.reload();
              close();
            }}
          >
            <p className="muted">{selected.name}</p>
            <Field label="Operation">
              <select name="operation">
                <option value="copy">
                  Copy — keep an independent copy in both places
                </option>
                {selected.access === "write" ? (
                  <option value="move">
                    Move — remove from the original location
                  </option>
                ) : null}
              </select>
            </Field>
            <Field label="Destination">
              <select name="destination" defaultValue={project?.id ?? ""}>
                <option value="">Organization files</option>
                {projects.data?.items
                  .filter((p) => p.access === "write")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field
              label="Destination folder"
              hint="Leave empty for the root folder."
            >
              <input name="path" placeholder="Folder/subfolder" />
            </Field>
          </AsyncForm>
        </Modal>
      ) : null}
      {dialog === "sharing" && selected ? (
        <FileSharing
          file={selected}
          projects={projects.data?.items ?? []}
          onClose={close}
        />
      ) : null}
      {dialog === "grants" && selected ? (
        <FileGrants file={selected} onClose={close} />
      ) : null}
      {dialog === "versions" && selected ? (
        <Versions file={selected} suffix={suffix} onClose={close} />
      ) : null}
      {deleting ? (
        <Confirm
          title="Delete this item?"
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            await api(`/api/files/${deleting.id}${suffix}`, {
              method: "DELETE",
            });
            files.reload();
            setDeleting(undefined);
          }}
        >
          Delete “{deleting.name}”
          {deleting.kind !== "file" ? " and its contents" : ""}? Shared project
          access to this item will also be affected.
        </Confirm>
      ) : null}
    </section>
  );
}
function FileSharing({
  file,
  projects,
  onClose,
}: {
  file: FileEntry;
  projects: Project[];
  onClose: () => void;
}) {
  const resource = useResource<List<Share>>(`/api/files/${file.id}/shares`);
  const [error, setError] = useState("");
  return (
    <Modal title="Shared with projects" onClose={onClose}>
      <p className="muted">
        Projects access the same underlying files. Changes stay consistent.
      </p>
      <ErrorNotice message={resource.error || error} />
      {resource.data?.items.map((s) => (
        <div className="setting-row" key={s.projectId}>
          <div>
            <strong>
              {s.projectName ||
                projects.find((p) => p.id === s.projectId)?.name ||
                s.projectId}
            </strong>
            <small>{s.access === "write" ? "Read & write" : "Read only"}</small>
          </div>
          <button
            className="text-button danger"
            onClick={async () => {
              try {
                await api(`/api/files/${file.id}/shares/${s.projectId}`, {
                  method: "DELETE",
                });
                resource.reload();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Unshare
          </button>
        </div>
      ))}
      <AsyncForm
        submitLabel="Share with project"
        onSubmit={async (d) => {
          await send(`/api/files/${file.id}/shares`, {
            projectId: d.get("projectId"),
            access: d.get("access"),
          });
          resource.reload();
        }}
      >
        <Field label="Project">
          <select name="projectId" required defaultValue="">
            <option value="" disabled>
              Select a project
            </option>
            {projects
              .filter(
                (p) => !resource.data?.items.some((s) => s.projectId === p.id),
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
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
      </AsyncForm>
    </Modal>
  );
}
function FileGrants({
  file,
  onClose,
}: {
  file: FileEntry;
  onClose: () => void;
}) {
  const { org } = useWorkspace();
  const members = useResource<List<User>>(
    `/api/organizations/${org.id}/members`,
  );
  const grants = useResource<
    List<{ userId: string; name?: string; access: string }>
  >(`/api/files/${file.id}/grants`);
  const [error, setError] = useState("");
  return (
    <Modal title="People with access" onClose={onClose}>
      <p className="muted">
        Organization administrators manage all organization files.
      </p>
      <ErrorNotice message={grants.error || members.error || error} />
      {grants.data?.items.map((g) => (
        <div className="setting-row" key={g.userId}>
          <div>
            {members.data?.items.find((u) => u.id === g.userId)?.name ||
              g.userId}
            <small>{g.access === "write" ? "Read & write" : "Read only"}</small>
          </div>
          <button
            className="text-button danger"
            onClick={async () => {
              try {
                await api(`/api/files/${file.id}/grants/${g.userId}`, {
                  method: "DELETE",
                });
                grants.reload();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <AsyncForm
        submitLabel="Grant access"
        onSubmit={async (d) => {
          await send(`/api/files/${file.id}/grants`, {
            userId: d.get("userId"),
            access: d.get("access"),
          });
          grants.reload();
        }}
      >
        <Field label="Person">
          <select name="userId" required defaultValue="">
            <option value="" disabled>
              Select a person
            </option>
            {members.data?.items
              .filter((u) => u.enabled)
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
      </AsyncForm>
    </Modal>
  );
}
function Versions({
  file,
  suffix,
  onClose,
}: {
  file: FileEntry;
  suffix: string;
  onClose: () => void;
}) {
  const { orgBase } = useWorkspace();
  const versions = useResource<
    List<{
      id: string;
      version?: number;
      number?: number;
      size: number;
      createdAt: string;
    }>
  >(`/api/files/${file.id}/versions${suffix}`);
  return (
    <Modal title="Version history" onClose={onClose}>
      <p>{file.name}</p>
      <ErrorNotice message={versions.error} />
      {versions.loading ? (
        <Loading />
      ) : (
        versions.data?.items.map((v, i) => (
          <div className="setting-row" key={v.id}>
            <div>
              <strong>
                Version{" "}
                {v.number ?? v.version ?? versions.data!.items.length - i}
              </strong>
              <small>{date(v.createdAt)}</small>
            </div>
            <div className="row-actions">
              <Link
                className="secondary button-link"
                to={`${orgBase}${sourcePath(file.id, {
                  projectId: new URLSearchParams(suffix).get("projectId"),
                  versionId: v.id,
                })}`}
              >
                Open
              </Link>
              <a
                className="secondary button-link"
                href={`/api/files/${file.id}/content${suffix ? `${suffix}&` : "?"}versionId=${encodeURIComponent(v.id)}`}
                download
              >
                <Download size={15} />
                {bytes(v.size)}
              </a>
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}
