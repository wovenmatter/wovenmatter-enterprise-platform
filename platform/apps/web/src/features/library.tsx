import { useCallback, useState } from "react";
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
import { AssetPreparation } from "./asset-preparation";

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
export type Asset = {
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
          key={selected}
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
  const changed = useCallback(() => {
    asset.reload();
    onChanged();
  }, [asset.reload, onChanged]);
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
              <AssetPreparation key={a.id} asset={a} onSaved={changed} />
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
              {a.canEdit ? (
                <AsyncForm
                  key={`metadata-${a.revision}`}
                  submitLabel="Save details"
                  onSubmit={async (d) => {
                    await send(
                      `/enterprise/api/assets/${id}`,
                      {
                        name: d.get("name"),
                        description: d.get("description"),
                        expectedRevision: a.revision,
                      },
                      "PATCH",
                    );
                    changed();
                  }}
                >
                  <Field label="Name">
                    <input
                      name="name"
                      defaultValue={a.name}
                      required
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Description">
                    <textarea
                      name="description"
                      defaultValue={a.description}
                      rows={3}
                      maxLength={2000}
                    />
                  </Field>
                </AsyncForm>
              ) : null}
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
