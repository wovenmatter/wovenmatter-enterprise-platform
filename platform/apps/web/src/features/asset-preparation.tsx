import { useCallback, useState } from "react";
import { ExternalLink } from "lucide-react";
import { send, useResource, errorMessage, type List } from "../api";
import { useWorkspace } from "../workspace";
import { AsyncForm, ErrorNotice, Field, Loading } from "../components/ui";
import { Thread, type Conversation, type Model } from "./conversations";
import type { Asset } from "./library";

type Agent = {
  conversation: Conversation | null;
  state: string;
  sources: { id: string; path: string; kind: string }[];
};
export function AssetPreparation({
  asset,
  onSaved,
}: {
  asset: Asset;
  onSaved: () => void;
}) {
  const { org } = useWorkspace();
  const agent = useResource<Agent>(
    `/enterprise/api/assets/${asset.id}/agent`,
    5000,
  );
  const models = useResource<List<Model>>(
    `/enterprise/api/organizations/${org.id}/inference/models`,
  );
  const [mode, setMode] = useState("read"),
    [starting, setStarting] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(() => {
    agent.reload();
  }, [agent.reload]);
  const saved = useCallback(() => {
    onSaved();
    agent.reload();
  }, [agent.reload, onSaved]);
  async function start() {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      await send<Conversation>(
        "/enterprise/api/assets/" + asset.id + "/agent",
        { mode },
      );
      agent.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }
  return (
    <div className="asset-preparation">
      <section className="asset-chat" aria-label="Asset conversation">
        <div className="asset-work-state" role="status">
          {agent.data?.conversation?.activeRun ? "Working" : "Ready"}
        </div>
        <ErrorNotice message={agent.error || error} />
        {!agent.data && agent.loading ? (
          <Loading />
        ) : agent.data?.conversation ? (
          <Thread
            key={agent.data.conversation.id}
            id={agent.data.conversation.id}
            models={models.data?.items ?? []}
            refresh={refresh}
            onDeleted={refresh}
            asset={{ onSaved: saved }}
          />
        ) : (
          <form
            className="asset-first-prompt"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <h3>Start a session</h3>
            <Field
              label="Session permissions"
              hint="Access is fixed for this session."
            >
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                disabled={starting}
              >
                <option value="read">Read-only</option>
                <option value="write">Full access</option>
              </select>
            </Field>
            <button className="primary" disabled={starting}>
              {starting ? "Starting…" : "Start session"}
            </button>
          </form>
        )}
        {!asset.projectId && agent.data ? (
          <AssetSources
            assetId={asset.id}
            sources={agent.data.sources}
            onChanged={refresh}
          />
        ) : null}
        {!asset.projectId ? (
          <p className="muted asset-idle-note">
            Your work and conversation are saved. After a pause, send another
            message to continue. Background work ends when this workspace rests.
          </p>
        ) : null}
      </section>
      <section className="asset-draft-preview" aria-label="Draft preview">
        <div className="section-heading-row">
          <h3>Draft preview</h3>
          <a
            href={`${asset.url}/preview`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open draft preview"
          >
            <ExternalLink size={17} />
          </a>
        </div>
        <p className="muted">
          Private draft · Revision {asset.revision}. Publish when you are ready
          to share.
        </p>
        <iframe
          key={`${asset.id}:${asset.revision}`}
          title="Draft preview"
          sandbox=""
          referrerPolicy="no-referrer"
          src={`${asset.url}/preview?revision=${asset.revision}`}
        />
      </section>
    </div>
  );
}
function AssetSources({
  assetId,
  sources,
  onChanged,
}: {
  assetId: string;
  sources: Agent["sources"];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="asset-sources"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Library sources ({sources.length})</summary>
      <p>
        Choose optional library files or folders for the agent to read. Changes
        stop current work so the new access takes effect.
      </p>
      {open ? (
        <SourcePicker
          key={sources.map((s) => s.id).join(",")}
          assetId={assetId}
          sources={sources}
          onChanged={onChanged}
        />
      ) : null}
    </details>
  );
}
function SourcePicker({
  assetId,
  sources,
  onChanged,
}: {
  assetId: string;
  sources: Agent["sources"];
  onChanged: () => void;
}) {
  const { org } = useWorkspace(),
    [path, setPath] = useState("");
  const [selected, setSelected] = useState(() =>
    Object.fromEntries(sources.map((s) => [s.id, s.path])),
  );
  const files = useResource<
    List<{ id: string; name: string; path: string; kind: string }>
  >(`/enterprise/api/files?${new URLSearchParams({ orgId: org.id, path })}`);
  function choose(id: string, name: string, checked: boolean) {
    setSelected((previous) => {
      const next = { ...previous };
      if (checked) next[id] = name;
      else delete next[id];
      return next;
    });
  }
  return (
    <AsyncForm
      submitLabel="Use selected sources"
      onSubmit={async () => {
        await send(
          `/enterprise/api/assets/${assetId}/sources`,
          { fileIds: Object.keys(selected) },
          "PUT",
        );
        onChanged();
      }}
    >
      <nav aria-label="Source folder">
        <button
          type="button"
          disabled={!path}
          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
        >
          Up one folder
        </button>
        <span>{path || "Library"}</span>
      </nav>
      <ErrorNotice message={files.error} />
      {files.loading ? (
        <Loading />
      ) : (
        files.data?.items.map((f) => (
          <div key={f.id} className="source-picker-row">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Object.hasOwn(selected, f.id)}
                onChange={(e) => choose(f.id, f.path, e.target.checked)}
              />
              {f.name || f.path}
            </label>
            {f.kind === "folder" ? (
              <button
                type="button"
                onClick={() => setPath(f.path)}
                aria-label={`Open folder ${f.name}`}
              >
                Open
              </button>
            ) : null}
          </div>
        ))
      )}
      {Object.entries(selected)
        .filter(([id]) => !files.data?.items.some((f) => f.id === id))
        .map(([id, name]) => (
          <label key={id} className="checkbox-row">
            <input
              type="checkbox"
              checked
              onChange={() => choose(id, name, false)}
            />
            {name}
          </label>
        ))}
    </AsyncForm>
  );
}
