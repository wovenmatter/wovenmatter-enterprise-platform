import { useState } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { api, date, send, useResource, type List, type Project } from "../api";
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
} from "../components/ui";
import { FilesPage } from "./files";

type Block = {
  type: string;
  text?: string;
  title?: string;
  fileId?: string;
  alt?: string;
  pointer?: string;
  columns?: { label: string; key: string }[];
  labelKey?: string;
  valueKey?: string;
};
type Asset = {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  visibility: string;
  status: string;
  url: string;
  canManage: boolean;
  canEdit: boolean;
  publishedVersion: number;
  revision: number;
  hasUnpublishedChanges: boolean;
  document: { version: 1; blocks: Block[] };
  versions: { number: number; name: string; createdAt: string }[];
};
function Visibility({ project, value }: { project: boolean; value: string }) {
  return (
    <Field label="Visibility">
      <select name="visibility" defaultValue={value}>
        {project ? <option value="project">Project</option> : null}
        <option value="organization">Organization</option>
        <option value="public">Public</option>
      </select>
    </Field>
  );
}
export function LibraryPage() {
  const { org, isAdmin } = useWorkspace();
  const assets = useResource<List<Asset>>(
    `/enterprise/api/organizations/${org.id}/assets`,
  );
  const projects = useResource<List<Project>>(
    `/enterprise/api/organizations/${org.id}/projects`,
  );
  const [view, setView] = useState("files");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string>();
  const writable =
    projects.data?.items.filter((p) => p.access === "write") ?? [];
  const canCreate = isAdmin || writable.length > 0;
  const action = (
    <button
      className="primary"
      disabled={!canCreate}
      onClick={() => setCreating(true)}
    >
      <Plus size={17} /> New asset
    </button>
  );
  return (
    <section className="library-page">
      <PageHeader
        title="Library"
        description="Organization files and shared assets."
        actions={
          <div className="tabs" role="group" aria-label="Library view">
            {[
              ["files", "Files"],
              ["assets", "Assets"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={view === key ? "active" : ""}
                aria-pressed={view === key}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      <ErrorNotice message={assets.error || projects.error} />
      {!canCreate && !projects.loading ? (
        <p className="muted">
          Full project access is needed to create a project asset. Organization
          administrators can also create organization assets.
        </p>
      ) : null}
      <div hidden={view !== "files"}>
        <FilesPage embedded leadingActions={action} />
      </div>
      {view === "assets" ? (
        <section className="section-block">
          <div className="section-heading-row">
            <h2>Assets</h2>
            <div className="actions">{action}</div>
          </div>
          {assets.loading ? (
            <Loading />
          ) : assets.data?.items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Belongs to</th>
                    <th>Status</th>
                    <th>Visibility</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.data.items.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.canManage ? (
                          <button
                            className="text-button item-link"
                            onClick={() => setSelected(a.id)}
                          >
                            {a.name}
                          </button>
                        ) : (
                          <a href={a.url} target="_blank" rel="noreferrer">
                            {a.name} <ExternalLink size={15} />
                          </a>
                        )}
                        {a.description ? <small>{a.description}</small> : null}
                      </td>
                      <td>
                        {a.projectId
                          ? (projects.data?.items.find(
                              (p) => p.id === a.projectId,
                            )?.name ?? "Project")
                          : "Organization"}
                      </td>
                      <td>
                        <Status value={a.status} />
                      </td>
                      <td>{a.visibility}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No assets yet">
              Create an asset, prepare its content, then publish it when it is
              ready to share.
            </Empty>
          )}
        </section>
      ) : null}
      {creating ? (
        <Modal title="New asset" onClose={() => setCreating(false)}>
          <AsyncForm
            submitLabel="Create asset"
            onCancel={() => setCreating(false)}
            onSubmit={async (d) => {
              const a = await send<Asset>(
                `/enterprise/api/organizations/${org.id}/assets`,
                {
                  name: d.get("name"),
                  description: d.get("description"),
                  projectId: d.get("projectId") || null,
                  draft: true,
                },
              );
              assets.reload();
              setCreating(false);
              setView("assets");
              setSelected(a.id);
            }}
          >
            <Field label="Name">
              <input name="name" required maxLength={200} autoFocus />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} maxLength={2000} />
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
            <p className="muted">
              Start a private draft. You can add content and preview it before
              choosing who can view the published asset.
            </p>
          </AsyncForm>
        </Modal>
      ) : null}
      {selected ? (
        <AssetDetail
          id={selected}
          onClose={() => setSelected(undefined)}
          onChanged={assets.reload}
        />
      ) : null}
    </section>
  );
}
function AssetDetail({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const asset = useResource<Asset>(`/enterprise/api/assets/${id}`);
  const [tab, setTab] = useState("content"),
    [removing, setRemoving] = useState(false);
  const a = asset.data;
  const changed = () => {
    asset.reload();
    onChanged();
  };
  return (
    <Modal title={a?.name ?? "Asset"} onClose={onClose} wide>
      <ErrorNotice message={asset.error} />
      {!a ? (
        asset.loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          <div className="asset-summary">
            <Status value={a.status} />
            <span>{a.projectId ? "Project asset" : "Organization asset"}</span>
          </div>
          <nav className="tabs" aria-label="Asset views">
            {[
              ["content", "Prepare"],
              ["publish", "Publish"],
              ["versions", "Versions"],
              ["settings", "Settings"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === "content" ? (
            a.canEdit ? (
              <AssetEditor key={a.revision} asset={a} onSaved={changed} />
            ) : (
              <p>Full access is needed to edit this asset.</p>
            )
          ) : null}
          {tab === "publish" ? (
            <div className="asset-section">
              <p>
                {a.hasUnpublishedChanges
                  ? "This draft has unpublished changes. Preview your saved draft before publishing."
                  : "The saved content matches the published version."}
              </p>
              <a
                className="secondary button-link"
                href={`${a.url}/preview`}
                target="_blank"
                rel="noreferrer"
              >
                Preview draft <ExternalLink size={16} />
              </a>
              {a.publishedVersion ? (
                <p>
                  <a href={a.url} target="_blank" rel="noreferrer">
                    Open published asset <ExternalLink size={16} />
                  </a>
                </p>
              ) : null}
              {a.canEdit ? (
                <AsyncForm
                  key={a.revision}
                  submitLabel={
                    a.publishedVersion ? "Publish new version" : "Publish asset"
                  }
                  onSubmit={async (d) => {
                    await send(`/enterprise/api/assets/${id}/publish`, {
                      expectedRevision: a.revision,
                      visibility: d.get("visibility"),
                    });
                    changed();
                  }}
                >
                  <Visibility project={!!a.projectId} value={a.visibility} />
                  <p className="muted">
                    Publishing shares the saved content with the selected
                    audience. Public assets can be viewed without signing in.
                    Selected source data updates on page load.
                  </p>
                </AsyncForm>
              ) : null}
            </div>
          ) : null}
          {tab === "versions" ? (
            <div className="asset-section">
              <h3>Published versions</h3>
              {a.versions?.length ? (
                a.versions.map((v) => (
                  <div className="setting-row" key={v.number}>
                    <div>
                      <strong>
                        Version {v.number}
                        {v.number === a.publishedVersion ? " · Current" : ""}
                      </strong>
                      <small>
                        {v.name} · {date(v.createdAt)}
                      </small>
                    </div>
                    {a.canEdit ? (
                      <AsyncForm
                        children={null}
                        submitLabel={`Restore version ${v.number} to draft`}
                        onSubmit={async () => {
                          await send(
                            `/enterprise/api/assets/${id}/versions/${v.number}/restore`,
                            { expectedRevision: a.revision },
                          );
                          changed();
                          setTab("content");
                        }}
                      />
                    ) : null}
                  </div>
                ))
              ) : (
                <p>No published versions yet.</p>
              )}
              <p className="muted">
                Restoring a version changes the private draft. Publish it to
                update the shared asset. Source data always uses current
                authorized files.
              </p>
            </div>
          ) : null}
          {tab === "settings" ? (
            <div className="asset-section">
              {a.publishedVersion ? (
                <AsyncForm
                  key={a.revision}
                  submitLabel="Change visibility"
                  onSubmit={async (d) => {
                    await send(
                      `/enterprise/api/assets/${id}`,
                      { visibility: d.get("visibility") },
                      "PATCH",
                    );
                    changed();
                  }}
                >
                  <Visibility project={!!a.projectId} value={a.visibility} />
                  <p className="muted">
                    This immediately changes access to the published asset.
                  </p>
                </AsyncForm>
              ) : (
                <p>This draft is private until you publish it.</p>
              )}
              <button
                className="secondary danger"
                onClick={() => setRemoving(true)}
              >
                Remove asset
              </button>
            </div>
          ) : null}
          {removing ? (
            <Confirm
              title="Remove asset?"
              onClose={() => setRemoving(false)}
              onConfirm={async () => {
                await api(`/enterprise/api/assets/${id}`, { method: "DELETE" });
                onChanged();
                onClose();
              }}
            >
              The published link will stop working immediately.
            </Confirm>
          ) : null}
        </>
      )}
    </Modal>
  );
}
const blockNames: Record<string, string> = {
  heading: "Heading",
  text: "Text",
  details: "Expandable section",
  table: "Table",
  bars: "Bar chart",
  image: "Image",
};
function newBlock(type: string): Block {
  if (type === "heading" || type === "text") return { type, text: "" };
  if (type === "details") return { type, title: "", text: "" };
  if (type === "image") return { type, fileId: "", alt: "" };
  if (type === "table")
    return { type, fileId: "", pointer: "", columns: [{ label: "", key: "" }] };
  return {
    type,
    fileId: "",
    pointer: "",
    labelKey: "",
    valueKey: "",
    title: "",
  };
}
function AssetEditor({
  asset: a,
  onSaved,
}: {
  asset: Asset;
  onSaved: () => void;
}) {
  const { org } = useWorkspace();
  const [blocks, setBlocks] = useState(a.document.blocks),
    [source, setSource] = useState("edit"),
    [path, setPath] = useState("");
  const query = new URLSearchParams({
    orgId: org.id,
    path,
    ...(a.projectId ? { projectId: a.projectId } : {}),
  });
  const files = useResource<
    List<{ id: string; path: string; name: string; kind: string }>
  >(`/enterprise/api/files?${query}`);
  const update = (i: number, changes: Partial<Block>) =>
    setBlocks((current) =>
      current.map((b, j) => (j === i ? { ...b, ...changes } : b)),
    );
  return (
    <AsyncForm
      submitLabel="Save draft"
      onSubmit={async (d) => {
        await send(
          `/enterprise/api/assets/${a.id}`,
          {
            expectedRevision: a.revision,
            name: d.get("name"),
            description: d.get("description"),
            ...(source === "existing"
              ? { sourceFileId: d.get("sourceFileId") }
              : { document: { version: 1, blocks } }),
          },
          "PATCH",
        );
        onSaved();
      }}
    >
      <Field label="Name">
        <input name="name" defaultValue={a.name} required maxLength={200} />
      </Field>
      <Field label="Description">
        <textarea
          name="description"
          defaultValue={a.description}
          rows={2}
          maxLength={2000}
        />
      </Field>
      <Field label="Content">
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="edit">Write or edit content</option>
          <option value="existing">Use prepared workspace content</option>
        </select>
      </Field>
      <details>
        <summary>Browse content sources</summary>
        <Field
          label="Source folder"
          hint="Use a folder in this workspace or an available library share."
        >
          <input value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <ErrorNotice message={files.error} />
        {files.loading ? <Loading /> : null}
      </details>
      {source === "existing" ? (
        <>
          <Field label="Content file">
            <select name="sourceFileId" required defaultValue="">
              <option value="" disabled>
                Select prepared content
              </option>
              {files.data?.items
                .filter((f) => f.kind === "file" && f.path.endsWith(".json"))
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
            </select>
          </Field>
          <p className="muted">
            Choose a safe asset definition prepared by your agent. You can edit
            its content after saving.
          </p>
        </>
      ) : (
        <>
          {blocks.map((b, i) => (
            <section
              className="asset-section"
              key={i}
              aria-label={`${blockNames[b.type]} ${i + 1}`}
            >
              <div className="section-heading-row">
                <h3>
                  {blockNames[b.type]} {i + 1}
                </h3>
                <button
                  type="button"
                  className="text-button"
                  disabled={blocks.length === 1}
                  onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}
                >
                  Remove section {i + 1}
                </button>
              </div>
              {b.title !== undefined ? (
                <Field label="Section title">
                  <input
                    value={b.title}
                    maxLength={200}
                    onChange={(e) => update(i, { title: e.target.value })}
                  />
                </Field>
              ) : null}
              {b.text !== undefined ? (
                <Field label={b.type === "heading" ? "Heading" : "Text"}>
                  <textarea
                    rows={b.type === "heading" ? 1 : 5}
                    maxLength={b.type === "heading" ? 200 : 8000}
                    value={b.text}
                    onChange={(e) => update(i, { text: e.target.value })}
                  />
                </Field>
              ) : null}
              {b.fileId !== undefined ? (
                <Field label="Source file">
                  <select
                    required
                    value={b.fileId}
                    onChange={(e) => update(i, { fileId: e.target.value })}
                  >
                    <option value="" disabled>
                      Select a file
                    </option>
                    {b.fileId &&
                    !files.data?.items.some((f) => f.id === b.fileId) ? (
                      <option value={b.fileId}>Current source</option>
                    ) : null}
                    {files.data?.items
                      .filter((f) => f.kind === "file")
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.path}
                        </option>
                      ))}
                  </select>
                </Field>
              ) : null}
              {b.alt !== undefined ? (
                <Field label="Image description">
                  <input
                    value={b.alt}
                    maxLength={200}
                    onChange={(e) => update(i, { alt: e.target.value })}
                  />
                </Field>
              ) : null}
              {b.pointer !== undefined ? (
                <Field
                  label="Data location"
                  hint="Leave empty for a list at the top of the source file, or enter a path such as /rows."
                >
                  <input
                    value={b.pointer}
                    maxLength={512}
                    onChange={(e) => update(i, { pointer: e.target.value })}
                  />
                </Field>
              ) : null}
              {b.type === "bars" ? (
                <>
                  <Field label="Label field">
                    <input
                      required
                      value={b.labelKey}
                      onChange={(e) => update(i, { labelKey: e.target.value })}
                    />
                  </Field>
                  <Field label="Value field">
                    <input
                      required
                      value={b.valueKey}
                      onChange={(e) => update(i, { valueKey: e.target.value })}
                    />
                  </Field>
                </>
              ) : null}
              {b.columns?.map((c, j) => (
                <div className="form-grid" key={j}>
                  <Field label={`Column ${j + 1} heading`}>
                    <input
                      value={c.label}
                      onChange={(e) =>
                        update(i, {
                          columns: b.columns!.map((x, k) =>
                            k === j ? { ...x, label: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field label={`Column ${j + 1} field`}>
                    <input
                      required
                      value={c.key}
                      onChange={(e) =>
                        update(i, {
                          columns: b.columns!.map((x, k) =>
                            k === j ? { ...x, key: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    disabled={b.columns!.length === 1}
                    onClick={() =>
                      update(i, {
                        columns: b.columns!.filter((_, k) => k !== j),
                      })
                    }
                  >
                    Remove column {j + 1}
                  </button>
                </div>
              ))}
              {b.columns ? (
                <button
                  type="button"
                  disabled={b.columns.length >= 20}
                  onClick={() =>
                    update(i, {
                      columns: [...b.columns!, { label: "", key: "" }],
                    })
                  }
                >
                  Add column
                </button>
              ) : null}
            </section>
          ))}
          <Field label="Add section">
            <select
              value=""
              disabled={blocks.length >= 100}
              onChange={(e) => setBlocks([...blocks, newBlock(e.target.value)])}
            >
              <option value="" disabled>
                Choose a section
              </option>
              {Object.entries(blockNames).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <p className="muted">
        Save your draft, then use Publish to preview and share it. Saving does
        not change an existing published version.
      </p>
    </AsyncForm>
  );
}
