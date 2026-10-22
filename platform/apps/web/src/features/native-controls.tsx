import { useState } from "react";
import { Brain, Cpu, ShieldCheck } from "lucide-react";
import { send, useResource, type Conversation, type Model } from "../api";
import { agentName, acceptsModel } from "../agents";
import { Picker, Switch } from "../components/controls";
import { ErrorNotice, Field } from "../components/ui";
type Option = { id: string; label: string };
type NativeQuestion = { id: string; prompt: string; options: Option[]; allowsMultiple: boolean; allowsFreeText: boolean; required: boolean; type?: "string" | "boolean" | "number" | "integer" | "multiselect" | "external"; hidden?: boolean; default?: string[]; when?: {key:string;op:"eq"|"neq";value:string|string[]|number|boolean}[]; url?: string };
type Interaction = { id: string; kind: "approval" | "question"; title: string; detail?: string; options: Option[]; questions: NativeQuestion[] };
type Native = { harness: string; runId: string | null; configured: { thinking?: string; permission?: string }; settings: null | { model: string; thinking: string; permission: string; models: Option[]; thinkingLevels: Option[]; permissions: Option[]; canSteer: boolean; canConfigure: boolean }; interactions: Interaction[] };
export function NativeControls({ conversation, models, onSaved }: { conversation: Conversation; models: Model[]; onSaved: () => void }) {
  const native = useResource<Native>(`/enterprise/api/conversations/${conversation.id}/native`, 2500);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const settings = native.data?.settings;
  const modelOptions = models.filter(model => acceptsModel(conversation.harness, model.provider)).map(model => ({ value: model.id, label: settings?.models.find(option => option.id === model.id)?.label ?? model.name }));
  async function update(body: unknown) {
    setBusy(true); setError("");
    try { await send(`/enterprise/api/conversations/${conversation.id}`, body, "PATCH"); onSaved(); native.reload(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="native-controls"><ErrorNotice message={error || native.error} />
    {native.data?.interactions.map(interaction => <NativeInteraction key={interaction.id} conversationId={conversation.id} interaction={interaction} onResolved={native.reload} />)}
    <div className="native-selectors"><span className="native-agent-name">{agentName(conversation.harness)}</span>
      <Picker label="Native model" heading="Model" icon={Cpu} value={conversation.model || settings?.model || ""} placeholder="Agent default model" disabled={busy || settings?.canConfigure === false} options={modelOptions} onChange={model => void update({model})} />
      {settings?.thinkingLevels.length ? <Picker label="Native thinking level" heading="Thinking Level" icon={Brain} value={native.data?.configured.thinking ?? settings.thinking} placeholder="Thinking" disabled={busy || !settings.canConfigure} options={settings.thinkingLevels.map(option => ({ value: option.id, label: option.label }))} onChange={thinking => void update({ native: { thinking } })} /> : null}
      {settings?.permissions.length ? <Picker label="Native permissions" heading="Permissions" icon={ShieldCheck} value={native.data?.configured.permission ?? settings.permission} placeholder="Permissions" disabled={busy || !settings.canConfigure} options={settings.permissions.map(option => ({ value: option.id, label: option.label }))} onChange={permission => void update({ native: { permission } })} /> : null}
    </div>
    {settings && ((conversation.model && settings.model && conversation.model !== settings.model) || (native.data?.configured.thinking && native.data.configured.thinking !== settings.thinking) || (native.data?.configured.permission && native.data.configured.permission !== settings.permission)) ? <small role="status">Saved settings will apply on the next turn.</small> : null}
  </div>;
}
function NativeInteraction({ conversationId, interaction, onResolved }: { conversationId: string; interaction: Interaction; onResolved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => Object.fromEntries(interaction.questions.filter(question => question.default).map(question => [question.id, question.default!])));
  const [customKeys, setCustomKeys] = useState<Set<string>>(() => new Set());
  const active: NativeQuestion[] = [];
  const values: Record<string, unknown> = {};
  for (const question of interaction.questions ?? []) {
    if (!question.when?.every(condition => { const value = values[condition.key]; if (value === undefined || value === null) return false; const same = Array.isArray(value) ? value.includes(condition.value) : value === condition.value; return condition.op === "eq" ? same : !same; }) && question.when?.length) continue;
    active.push(question);
    const answer = answers[question.id] ?? question.default;
    values[question.id] = question.type === "boolean" || question.type === "external" ? answer?.[0] === "true" : question.type === "number" || question.type === "integer" ? answer?.[0] ? Number(answer[0]) : undefined : question.type === "multiselect" || question.allowsMultiple ? answer ?? [] : answer?.[0];
  }
  const invalid = active.some(question => {
    const value = answers[question.id] ?? question.default ?? [];
    if (question.type === "external") return value[0] !== "true";
    if (question.required && question.type !== "boolean" && !value.some(item => item.trim())) return true;
    return (question.type === "number" || question.type === "integer") && value[0] !== undefined && value[0] !== "" && (!Number.isFinite(Number(value[0])) || question.type === "integer" && !Number.isInteger(Number(value[0])));
  });
  const change = (id: string, value: string[]) => setAnswers(previous => ({...previous,[id]:value}));
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  async function respond(body: unknown) {
    setBusy(true); setError("");
    try { const result = await send<{ delivery: string; error?: string }>(`/enterprise/api/conversations/${conversationId}/native/respond`, { requestId, interactionId: interaction.id, ...(body as object) }); if (result.delivery === "rejected") { setRequestId(crypto.randomUUID()); setError(result.error ?? "The response was rejected. Review your answer and try again."); } else if (result.error) setError(result.error); else onResolved(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="native-interaction" aria-label={interaction.kind === "approval" ? "Agent approval" : "Agent question"}><strong>{interaction.title}</strong>{interaction.detail ? <p>{interaction.detail}</p> : null}<ErrorNotice message={error} />
    {active.filter(question => !question.hidden).map(question => {
      const value = answers[question.id] ?? question.default ?? [];
      const options = question.options ?? [];
      const selectedCustom = customKeys.has(question.id) || Boolean(value[0] && !options.some(option => option.id === value[0]));
      if (question.type === "boolean" || question.type === "external") return <div key={question.id}><Field label={question.prompt}>{question.type === "external" && /^https?:\/\//i.test(question.url ?? "") ? <a href={question.url} target="_blank" rel="noopener noreferrer">Open verification</a> : null}<Switch checked={value[0] === "true"} onChange={event => change(question.id, [String(event.target.checked)])}>{question.type === "external" ? "I’ve completed this step" : "Yes"}</Switch></Field></div>;
      if (question.type === "multiselect" || question.allowsMultiple) return <Field key={question.id} label={question.prompt}>{options.map(option => <Switch key={option.id} checked={value.includes(option.id)} onChange={event => change(question.id, event.target.checked ? [...value,option.id] : value.filter(id=>id!==option.id))}>{option.label}</Switch>)}{question.allowsFreeText ? <input aria-label={`Additional answers: ${question.prompt}`} placeholder="Additional choices, separated by commas" value={value.filter(id=>!options.some(option=>option.id===id)).join(", ")} onChange={event=>change(question.id,[...value.filter(id=>options.some(option=>option.id===id)),...event.target.value.split(",").map(item=>item.trim()).filter(Boolean)])} /> : null}</Field>;
      return <Field key={question.id} label={question.prompt}>{options.length ? <select aria-label={`Choose: ${question.prompt}`} value={selectedCustom ? "__custom__" : value[0] ?? ""} onChange={event => { const custom=event.target.value==="__custom__";setCustomKeys(previous=>{const next=new Set(previous);if(custom)next.add(question.id);else next.delete(question.id);return next;});change(question.id,custom? [""]:[event.target.value]); }}><option value="">Choose…</option>{options.map(option=><option value={option.id} key={option.id}>{option.label}</option>)}{question.allowsFreeText?<option value="__custom__">Custom answer…</option>:null}</select> : null}{!options.length || question.allowsFreeText && selectedCustom ? <input aria-label={`Answer: ${question.prompt}`} type={question.type === "number" || question.type === "integer" ? "number" : "text"} step={question.type === "integer" ? 1 : "any"} value={value[0] ?? ""} onChange={event => change(question.id,[event.target.value])} /> : null}</Field>;
    })}
    <div className="row-actions">{interaction.options?.map(option => <button key={option.id} className="secondary" disabled={busy} onClick={() => void respond({ optionID: option.id })}>{option.label}</button>)}{interaction.questions?.length ? <button className="primary" disabled={busy || invalid} onClick={() => void respond({ answers: Object.fromEntries(active.map(question => [question.id, answers[question.id] ?? question.default ?? (question.type === "boolean" ? ["false"] : [])])) })}>Send answers</button> : null}<button className="text-button" disabled={busy} onClick={() => void respond({ cancelled: true })}>Cancel</button></div>
  </section>;
}
