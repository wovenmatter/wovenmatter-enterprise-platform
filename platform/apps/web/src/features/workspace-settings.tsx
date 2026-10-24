import { Link } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { agents } from "../agents";
import { send, useResource, type Project } from "../api";
import { useWorkspace } from "../workspace";
import { DisclosureChevron } from "../components/controls";
import { AsyncForm, Card, ErrorNotice, Field, Loading, PageHeader, Success } from "../components/ui";
type AgentDefaults = { model?: string; thinking?: string; permission?: string; codeMode?: string; subagentConcurrency?: number };
type Settings = { defaultHarness: string; agents: Record<string, AgentDefaults> };
export function WorkspaceSettings({ project, children }: { project: Project; children: ReactNode }) {
  const { isAdmin, orgBase } = useWorkspace();
  const settings = useResource<Settings>(`/enterprise/api/projects/${project.id}/agent-settings`);
  const [saved, setSaved] = useState("");
  return <section className="desktop-content-page settings-page"><PageHeader title="Settings" description={project.name} /><ErrorNotice message={settings.error} onRetry={settings.reload} />{saved ? <Success>{saved}</Success> : null}
    {settings.loading && !settings.data ? <Loading /> : settings.data ? <Card title="Agents" detail="Defaults for new conversations in this workspace.">
      <AsyncForm className={isAdmin ? undefined : "read-only-form"} submitLabel="Save agent defaults" onSubmit={async form => { const defaults = Object.fromEntries(agents.map(agent => [agent.id, { model: form.get(`${agent.id}.model`) || undefined, thinking: form.get(`${agent.id}.thinking`) || undefined, permission: form.get(`${agent.id}.permission`) || undefined, ...(agent.id === "pi" ? { codeMode: form.get("pi.codeMode"), subagentConcurrency: Number(form.get("pi.subagentConcurrency")) } : {}) }])); await send(`/enterprise/api/projects/${project.id}/agent-settings`, { defaultHarness: form.get("defaultHarness"), agents: defaults }, "PATCH"); settings.reload(); setSaved("Agent defaults saved."); }}>
        <fieldset className="agent-settings-fields" disabled={!isAdmin}><Field label="Default agent"><select name="defaultHarness" defaultValue={settings.data.defaultHarness}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
          {agents.map(agent => { const current = settings.data!.agents[agent.id] ?? {}; return <details className="settings-disclosure" key={agent.id}><summary><DisclosureChevron />{agent.name}</summary><p className="muted">{agent.detail}</p><div className="agent-settings-grid"><Field label="Default model"><input name={`${agent.id}.model`} defaultValue={current.model ?? ""} placeholder="Agent default" /></Field><Field label="Thinking level"><input name={`${agent.id}.thinking`} defaultValue={current.thinking ?? ""} placeholder="Agent default" /></Field>{agent.id !== "pi" ? <Field label="Native permission mode" hint="Use a mode supported by this agent. Native approval prompts remain available in chats."><input name={`${agent.id}.permission`} defaultValue={current.permission ?? ""} placeholder="Agent default" /></Field> : <><Field label="Code mode"><select name="pi.codeMode" defaultValue={current.codeMode ?? "on"}><option value="on">Enabled</option><option value="only">Code mode only</option><option value="off">Disabled</option></select></Field><Field label="Concurrent subagents"><input name="pi.subagentConcurrency" type="number" min={2} max={24} defaultValue={current.subagentConcurrency ?? 8} /></Field></>}</div></details>; })}
        </fieldset>{!isAdmin ? <p className="muted">An organization administrator can change workspace defaults. Conversation controls remain available to every member.</p> : null}
      </AsyncForm>
    </Card> : null}
    {isAdmin ? <Card title="Workspace management"><div className="destination-list"><Link className="nav-link" to={`${orgBase}/workspaces/${project.id}/members`}>Members</Link><Link className="nav-link" to={`${orgBase}/workspaces/${project.id}/connections`}>Connections</Link></div></Card> : null}
    {children}
  </section>;
}
