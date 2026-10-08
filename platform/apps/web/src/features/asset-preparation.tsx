import { useCallback, useState } from "react";
import { ExternalLink } from "lucide-react";
import { send, useResource, errorMessage, type List } from "../api";
import { useWorkspace } from "../workspace";
import { clearPendingMessage, savePendingMessage } from "../conversation-state";
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
  const { org, orgBase, user } = useWorkspace();
  const agent = useResource<Agent>(
    `/enterprise/api/assets/${asset.id}/agent`,
    5000,
  );
  const models = useResource<List<Model>>(
    `/enterprise/api/organizations/${org.id}/inference/models`,
  );
  const [draft, setDraft] = useState(""),
    [model, setModel] = useState(""),
    [harness, setHarness] = useState(""),
    [sending, setSending] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(() => {
    agent.reload();
  }, [agent.reload]);
  const saved = useCallback(() => {
    onSaved();
    agent.reload();
  }, [onSaved, agent.reload]);
  async function start() {
    if (sending || !draft.trim()) return;
    setSending(true);
    setError("");
    try {
      const c = await send<Conversation>(
        `/enterprise/api/assets/${asset.id}/agent`,
        { model: model || models.data?.items[0]?.id, harness: harness || null },
      );
      const pending = {
          id: crypto.randomUUID(),
          content: draft,
          kind: "message" as const,
        },
        key = `wme:pending:${user.id}:${c.id}`;
      savePendingMessage(key, pending);
      await send(`/enterprise/api/conversations/${c.id}/messages`, {
        requestId: pending.id,
        content: pending.content,
      });
      clearPendingMessage(key);
      setDraft("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
      agent.reload();
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
            <h3>What would you like to create?</h3>
            <p>
              Describe your asset. Your agent prepares the draft here, and you
              can ask for changes before publishing.
            </p>
            <Field label="Model">
              <select
                value={model || models.data?.items[0]?.id || ""}
                onChange={(e) => setModel(e.target.value)}
                required
              >
                <option value="" disabled>
                  Select a model
                </option>
                {models.data?.items.map((m) => (
                  <option key={`${m.provider}:${m.id}`} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Agent">
              <select
                value={harness}
                onChange={(e) => setHarness(e.target.value)}
              >
                <option value="">Pi Durable (default)</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
                <option value="grok">Grok Build</option>
                <option value="pi">Pi Durable</option>
              </select>
            </Field>
            <ErrorNotice message={models.error} />
            {!models.loading && !models.data?.items.length ? (
              <p>
                No models are available. Ask an administrator to configure a
                connection in <a href={`${orgBase}/connections`}>Connections</a>
                .
              </p>
            ) : null}
            <Field label="Message">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={5}
                maxLength={100000}
                placeholder="Create a summary of…"
                disabled={sending}
              />
            </Field>
            <button
              className="primary"
              disabled={sending || !draft.trim() || !models.data?.items.length}
            >
              {sending ? "Starting…" : "Send message"}
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
