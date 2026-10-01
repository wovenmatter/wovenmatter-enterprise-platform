import { useState } from "react";
import { BookOpen, Copy, ExternalLink, Plus } from "lucide-react";
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
import { FilesPage } from "./files";
type Asset = {
  id: string;
  orgId: string;
  projectId: string | null;
  name: string;
  description: string;
  type: "static" | "live";
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  versions?: Version[];
};
type Version = {
  id: string;
  number: number;
  entrypoint: string;
  runtimeStatus: string;
  runtimeError?: string;
  createdAt: string;
};
type Share = {
  id: string;
  visibility: string;
  userIds: string[];
  createdAt: string;
  revokedAt: string | null;
};
export function LibraryPage() {
  const { org, isAdmin } = useWorkspace();
  const assets = useResource<List<Asset>>(
    `/api/organizations/${org.id}/assets`,
  );
  const projects = useResource<List<Project>>(
    `/api/organizations/${org.id}/projects`,
  );
  const [view, setView] = useState<"files" | "outputs">("files");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Asset>();
  const writable =
    projects.data?.items.filter((p) => p.access === "write") ?? [];
  const newAsset = isAdmin || writable.length ? (
    <button className="primary" onClick={() => setCreating(true)}>
      <Plus size={17} /> New asset
    </button>
  ) : null;
  return (
    <section className="library-page">
      <PageHeader
        title="Library"
        description="Manage your organizations' files, static outputs, live dashboards, and more."
        actions={
          <div className="tabs library-view-toggle" role="group" aria-label="Library view">
            <button type="button" className={view === "files" ? "active" : ""}
              aria-pressed={view === "files"} onClick={() => setView("files")}>Files</button>
            <button type="button" className={view === "outputs" ? "active" : ""}
              aria-pressed={view === "outputs"} onClick={() => setView("outputs")}>Published Outputs</button>
          </div>
        }
      />
      <div hidden={view !== "files"}>
        <FilesPage embedded leadingActions={newAsset} />
      </div>
      <section className="section-block" hidden={view !== "outputs"}>
        <div className="section-heading-row">
          <div>
            <h2>Published outputs</h2>
            <p className="muted">
              Static assets and live dashboards published for the people who need them.
            </p>
          </div>
          <div className="actions">{newAsset}</div>
        </div>
      <ErrorNotice message={assets.error || projects.error} />
      {assets.loading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          {assets.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Type</th>
                  <th>Belongs to</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {assets.data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <button
                      className="text-button item-link"
                      onClick={() => setSelected(a)}
                    >
                      <BookOpen size={20} />
                      <div>
                        <strong>{a.name}</strong>
                        {a.description ? <small>{a.description}</small> : null}
                      </div>
                    </button>
                  </td>
                  <td>
                    {a.type === "live" ? "Live dashboard" : "Static asset"}
                  </td>
                  <td>
                    {projects.data?.items.find((p) => p.id === a.projectId)
                      ?.name ?? "Organization"}
                  </td>
                  <td>
                    <Status
                      value={a.currentVersionId ? "published" : "draft"}
                    />
                  </td>
                  <td>{date(a.updatedAt)}</td>
                </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No published outputs yet">
              Publish an output or dashboard to share work from your
              organization.
            </Empty>
          )}
        </div>
      )}
      </section>
      {creating ? (
        <Modal title="New library asset" onClose={() => setCreating(false)}>
          <AsyncForm
            submitLabel="Create asset"
            onCancel={() => setCreating(false)}
            onSubmit={async (d) => {
              const a = await send<Asset>(
                `/api/organizations/${org.id}/assets`,
                {
                  name: d.get("name"),
                  description: d.get("description"),
                  type: d.get("type"),
                  projectId: d.get("projectId") || undefined,
                },
              );
              assets.reload();
              setCreating(false);
              setView("outputs");
              setSelected(a);
            }}
          >
            <Field label="Name">
              <input name="name" required maxLength={160} autoFocus />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} maxLength={2000} />
            </Field>
            <Field label="Type">
              <select name="type">
                <option value="static">Static asset</option>
                <option value="live">Live dashboard</option>
              </select>
            </Field>
            <Field label="Belongs to">
              <select name="projectId" required={!isAdmin}>
                {isAdmin ? <option value="">Organization</option> : null}
                {writable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </AsyncForm>
        </Modal>
      ) : null}
      {selected ? (
        <AssetDetail
          key={selected.id}
          asset={selected}
          canEdit={isAdmin || writable.some((p) => p.id === selected.projectId)}
          onClose={() => setSelected(undefined)}
          onChange={assets.reload}
        />
      ) : null}
    </section>
  );
}
function AssetDetail({
  asset,
  canEdit,
  onClose,
  onChange,
}: {
  asset: Asset;
  canEdit: boolean;
  onClose: () => void;
  onChange: () => void;
}) {
  const detail = useResource<Asset>(`/api/assets/${asset.id}`);
  const [tab, setTab] = useState("overview");
  const [deleting, setDeleting] = useState(false);
  const [success, setSuccess] = useState("");
  const [resumeError, setResumeError] = useState("");
  const [resuming, setResuming] = useState(false);
  const a = detail.data ?? asset;
  function changed() {
    detail.reload();
    onChange();
  }
  return (
    <Modal title={a.name} onClose={onClose} wide>
      <div className="asset-summary">
        <Status value={a.type === "live" ? "live dashboard" : "static asset"} />
        <span className="muted">{a.description}</span>
      </div>
      <nav className="tabs" aria-label="Asset views">
        {[
          "overview",
          ...(canEdit ? ["publish", "sharing", "settings"] : []),
        ].map((t) => (
          <button
            className={tab === t ? "active" : ""}
            key={t}
            onClick={() => {
              setTab(t);
              setSuccess("");
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      <ErrorNotice message={detail.error || resumeError} />
      {success ? <Success>{success}</Success> : null}
      {tab === "overview" ? (
        <section className="asset-section">
          <h3>Published versions</h3>
          {a.versions?.length ? (
            a.versions.map((v) => (
              <div className="setting-row" key={v.id}>
                <div>
                  <strong>
                    Version {v.number}
                    {v.id === a.currentVersionId ? " · Current" : ""}
                  </strong>
                  <small>
                    {v.entrypoint} · {date(v.createdAt)}
                  </small>
                  {typeof v.runtimeError === "string" ? (
                    <small className="danger">{v.runtimeError}</small>
                  ) : null}
                </div>
                {a.type === "live" ? (
                  <div className="row-actions">
                    <Status value={v.runtimeStatus} />
                    {canEdit &&
                    v.id === a.currentVersionId &&
                    v.runtimeStatus !== "running" ? (
                      <button
                        className="secondary"
                        disabled={resuming}
                        onClick={async () => {
                          setResuming(true);
                          setResumeError("");
                          try {
                            const result = await send<{ version: Version }>(
                              `/api/assets/${a.id}/resume`,
                              { expectedVersionId: v.id },
                            );
                            changed();
                            setSuccess(
                              result.version.runtimeStatus === "running"
                                ? "Application resumed."
                                : "Application status updated.",
                            );
                          } catch (error) {
                            setResumeError(errorMessage(error));
                            detail.reload();
                          } finally {
                            setResuming(false);
                          }
                        }}
                      >
                        {resuming ? "Resuming…" : "Resume application"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <Empty
              title="Not published yet"
              action={
                canEdit ? (
                  <button className="primary" onClick={() => setTab("publish")}>
                    Publish first version
                  </button>
                ) : null
              }
            >
              A published version makes this asset available for sharing.
            </Empty>
          )}
        </section>
      ) : null}
      {tab === "publish" ? (
        <PublishAsset
          asset={a}
          onPublished={() => {
            changed();
            setTab("overview");
            setSuccess("A new version has been published.");
          }}
        />
      ) : null}
      {tab === "sharing" ? <AssetSharing asset={a} /> : null}
      {tab === "settings" ? (
        <div className="asset-section">
          <AsyncForm
            onSubmit={async (d) => {
              await send(
                `/api/assets/${a.id}`,
                { name: d.get("name"), description: d.get("description") },
                "PATCH",
              );
              changed();
              setSuccess("Asset updated.");
            }}
          >
            <Field label="Name">
              <input name="name" defaultValue={a.name} required />
            </Field>
            <Field label="Description">
              <textarea
                name="description"
                defaultValue={a.description}
                rows={3}
              />
            </Field>
          </AsyncForm>
          <div className="danger-zone">
            <h3>Remove asset</h3>
            <p className="muted">
              Removing an asset revokes its share links and stops its live
              application.
            </p>
            <button
              className="secondary danger"
              onClick={() => setDeleting(true)}
            >
              Delete asset
            </button>
          </div>
        </div>
      ) : null}
      {deleting ? (
        <Confirm
          title="Delete library asset?"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/api/assets/${a.id}`, { method: "DELETE" });
            onChange();
            onClose();
          }}
        >
          Delete “{a.name}” and revoke all its share links?
        </Confirm>
      ) : null}
    </Modal>
  );
}
async function base64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
function PublishAsset({
  asset,
  onPublished,
}: {
  asset: Asset;
  onPublished: () => void;
}) {
  const [source, setSource] = useState("upload");
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const params = new URLSearchParams({
    orgId: asset.orgId,
    path,
    ...(asset.projectId ? { projectId: asset.projectId } : {}),
  });
  const sources = useResource<
    List<{ id: string; name: string; path: string; kind: string }>
  >(source === "existing" ? `/api/files?${params}` : null);
  return (
    <div className="asset-section">
      <AsyncForm
        submitLabel="Publish version"
        onSubmit={async (d) => {
          const body: Record<string, unknown> = {
            expectedVersionId: asset.currentVersionId,
            entrypoint: d.get("entrypoint"),
          };
          if (source === "existing") body.sourceFileId = d.get("sourceFileId");
          else {
            if (!files.length) throw new Error("Choose the files to publish.");
            if (
              files.length > 1000 ||
              files.reduce((n, f) => n + f.size, 0) > 32 * 1024 * 1024
            )
              throw new Error(
                "A publication can contain up to 1,000 files and 32 MB.",
              );
            body.files = await Promise.all(
              files.map(async (f) => ({
                path: f.webkitRelativePath
                  ? f.webkitRelativePath.split("/").slice(1).join("/")
                  : f.name,
                contentBase64: await base64(f),
              })),
            );
          }
          if (asset.type === "live") body.dataFileIds = d.getAll("dataFileId");
          await send(`/api/assets/${asset.id}/publish`, body);
          onPublished();
        }}
      >
        <Field label="Source">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="upload">Upload files</option>
            <option value="existing">Use workspace files</option>
          </select>
        </Field>
        {source === "upload" ? (
          <>
            <Field label="Files">
              <input
                type="file"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </Field>
            <Field label="Or choose a folder">
              <input
                type="file"
                multiple
                {...{ webkitdirectory: "" }}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </Field>
            {files.length ? (
              <p className="muted">{files.length} files selected</p>
            ) : null}
          </>
        ) : (
          <>
            <Field label="Browse folder">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="Root folder"
              />
            </Field>
            <Field label="File or folder">
              <select name="sourceFileId" required defaultValue="">
                <option value="" disabled>
                  Select a source
                </option>
                {sources.data?.items.map((f) => (
                  <option value={f.id} key={f.id}>
                    {f.name}
                    {f.kind !== "file" ? " /" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <ErrorNotice message={sources.error} />
          </>
        )}
        <Field
          label="Entry file"
          hint={
            asset.type === "live"
              ? "The bundled Node application must listen on the supplied HOST and PORT."
              : "The file visitors will open first."
          }
        >
          <input
            name="entrypoint"
            required
            defaultValue={asset.type === "live" ? "server.mjs" : "index.html"}
          />
        </Field>
        {asset.type === "live" ? <LiveDataSources asset={asset} /> : null}
        <p className="muted">
          Publishing saves an immutable version.{" "}
          {asset.type === "live"
            ? "Existing live links follow the newly published version."
            : "Existing static links continue to show their original version."}
        </p>
      </AsyncForm>
    </div>
  );
}
function LiveDataSources({ asset }: { asset: Asset }) {
  const params = new URLSearchParams({
    orgId: asset.orgId,
    ...(asset.projectId ? { projectId: asset.projectId } : {}),
  });
  const files = useResource<List<{ id: string; name: string; kind: string }>>(
    `/api/files?${params}`,
  );
  return (
    <details>
      <summary>Linked data folders</summary>
      <p className="muted">
        Selected folders are available read-only to the application. Viewers do
        not receive access to your other files.
      </p>
      <ErrorNotice message={files.error} />
      <div className="checklist">
        {files.data?.items
          .filter((f) => f.kind !== "file")
          .map((f) => (
            <label key={f.id} className="checkbox">
              <input name="dataFileId" value={f.id} type="checkbox" />
              {f.name}
            </label>
          ))}
      </div>
    </details>
  );
}
function AssetSharing({ asset }: { asset: Asset }) {
  const { org } = useWorkspace();
  const shares = useResource<List<Share>>(`/api/assets/${asset.id}/shares`);
  const members = useResource<List<User>>(
    `/api/organizations/${org.id}/members`,
  );
  const [visibility, setVisibility] = useState("organization");
  const [createdUrl, setCreatedUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <div className="asset-section">
      <ErrorNotice message={shares.error || error} />
      {createdUrl ? (
        <div className="share-result">
          <strong>Share link created</strong>
          <p className="muted">
            Copy this link now. The full link is only shown when it is created.
          </p>
          <input
            value={createdUrl}
            readOnly
            aria-label="Created share link"
            onFocus={(e) => e.target.select()}
          />
          <div className="row-actions">
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(createdUrl);
                  setCopied(true);
                } catch {
                  setError(
                    "Clipboard access is unavailable. Select and copy the link above.",
                  );
                }
              }}
            >
              <Copy size={16} />
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              href={createdUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="secondary button-link"
            >
              Open <ExternalLink size={15} />
            </a>
          </div>
        </div>
      ) : null}
      {shares.data?.items
        .filter((s) => !s.revokedAt)
        .map((s) => (
          <div className="setting-row" key={s.id}>
            <div>
              <strong>
                {s.visibility === "public"
                  ? "Anyone with the link"
                  : s.visibility === "organization"
                    ? "Anyone in this organization"
                    : "Selected people"}
              </strong>
              <small>Created {date(s.createdAt)}</small>
            </div>
            <button
              className="text-button danger"
              onClick={async () => {
                try {
                  await api(`/api/assets/${asset.id}/shares/${s.id}`, {
                    method: "DELETE",
                  });
                  shares.reload();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              Revoke
            </button>
          </div>
        ))}
      {!asset.currentVersionId ? (
        <p className="muted">
          Publish this asset before creating a share link.
        </p>
      ) : (
        <AsyncForm
          submitLabel="Create share link"
          onSubmit={async (d) => {
            const result = await send<{ url: string }>(
              `/api/assets/${asset.id}/shares`,
              {
                visibility,
                ...(visibility === "people"
                  ? { userIds: d.getAll("userId") }
                  : {}),
              },
            );
            setCreatedUrl(
              new URL(result.url, window.location.origin).toString(),
            );
            setCopied(false);
            shares.reload();
          }}
        >
          <Field label="Who can access">
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value="organization">
                Private — anyone in this organization
              </option>
              <option value="people">Private — selected people</option>
              <option value="public">Public — anyone with the link</option>
            </select>
          </Field>
          {visibility === "people" ? (
            <>
              <div className="checklist">
                {members.data?.items
                  .filter((u) => u.enabled !== false)
                  .map((u) => (
                    <label className="checkbox" key={u.id}>
                      <input type="checkbox" name="userId" value={u.id} />
                      {u.name || u.email}
                    </label>
                  ))}
              </div>
              <ErrorNotice message={members.error} />
            </>
          ) : null}
          <p className="muted">
            {visibility === "public"
              ? "Anyone who receives this URL can access the asset without signing in."
              : "People must sign in to their WovenMatter Enterprise Platform account to access this asset."}
          </p>
        </AsyncForm>
      )}
    </div>
  );
}
