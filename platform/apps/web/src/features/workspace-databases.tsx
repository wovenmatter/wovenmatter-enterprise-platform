import { useEffect, useState } from "react";
import { Database, Download, Play, Plus, Save } from "lucide-react";
import { errorMessage, send, type Project } from "../api";
import { Icon } from "../components/controls";
import { AsyncForm, Empty, ErrorNotice, Field, Loading, Modal, PageHeader } from "../components/ui";
type DatabaseInfo = { id: string; name: string; revision: number; updatedAt: string; preference: string };
type Query = { contractVersion: number; columns: string[]; rows: string[][] };
export function DatabasesPage({ project }: { project: Project }) {
  const base = `/enterprise/api/projects/${project.id}/databases`;
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [sql, setSql] = useState("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name");
  const [result, setResult] = useState<Query>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = databases.find(database => database.id === selected);
  async function reload() { const response = await send<{ databases: DatabaseInfo[] }>(base, { action: "list" }); setDatabases(response.databases); }
  useEffect(() => { let active = true; setLoading(true); void send<{ databases: DatabaseInfo[] }>(base, { action: "list" }).then(response => { if (active) { setDatabases(response.databases); setSelected(response.databases[0]?.id ?? ""); } }).catch(e => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [base]);
  async function run(action: "query" | "execute") {
    setBusy(true); setError(""); setNotice("");
    try { const response = await send<{ query?: Query; changes?: number }>(base, { action, databaseID: selected, sql }); if (response.query) setResult(response.query); else { setResult(undefined); setNotice("Statement executed."); } await reload(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function download() {
    try { const snapshot = await send<Record<string, unknown>>(base, { action: "snapshot", databaseID: selected }); const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${current?.name ?? "database"}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (e) { setError(errorMessage(e)); }
  }
  return <section className="desktop-content-page database-page"><PageHeader icon={<Icon icon={Database} size={18} />} title="Databases" description="Shared structured data for this workspace." actions={<button className="primary" onClick={() => setCreating(true)}><Icon icon={Plus} size={14} />New database</button>} /><ErrorNotice message={error} />
    {loading ? <Loading /> : <div className={`database-layout ${databases.length ? "" : "is-empty"}`}>{databases.length ? <aside className="document-list" aria-label="Workspace databases">{databases.map(database => <button className={`nav-link ${selected === database.id ? "active" : ""}`} key={database.id} onClick={() => { setSelected(database.id); setResult(undefined); setNotice(""); }}><Icon icon={Database} size={17} /><span>{database.name}<small>Revision {database.revision}</small></span></button>)}</aside> : null}
      {current ? <div className="database-workbench"><header className="database-toolbar"><h2>{current.name}</h2><button className="secondary" onClick={() => void download()}><Icon icon={Download} size={13} />Export snapshot</button><button className="secondary" onClick={async () => { try { const snapshot = await send<Record<string, unknown>>(base, { action: "snapshot", databaseID: selected }); await send(base, { action: "copy", snapshot, name: `${current.name} copy` }); await reload(); } catch (e) { setError(errorMessage(e)); } }}>Duplicate</button></header>
        <Field label="SQL"><textarea className="sql-editor" rows={5} value={sql} onChange={event => setSql(event.target.value)} spellCheck={false} /></Field>
        <div className="row-actions"><button className="primary" disabled={busy || !sql.trim()} onClick={() => void run("query")}><Icon icon={Play} size={13} />Run query</button><button className="secondary" disabled={busy || !sql.trim()} onClick={() => void run("execute")}><Icon icon={Save} size={13} />Execute changes</button><span role="status">{busy ? "Running…" : notice}</span></div>
        {result ? <div className="table-wrap query-result"><table><thead><tr>{result.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((cell, index) => <td key={index}>{cell === null ? <span className="muted">NULL</span> : String(cell)}</td>)}</tr>)}</tbody></table><small>{result.rows.length} rows</small></div> : null}
      </div> : <Empty title="No database selected" action={<button className="secondary" onClick={() => setCreating(true)}>Create database</button>}>Create a database to organize workspace data.</Empty>}
    </div>}
    {creating ? <Modal title="New database" onClose={() => setCreating(false)}><AsyncForm submitLabel="Create database" onCancel={() => setCreating(false)} onSubmit={async form => { const response = await send<DatabaseInfo & { database?: DatabaseInfo; databases?: DatabaseInfo[] }>(base, { action: "create", name: form.get("name") }); await reload(); if (response.id || response.database?.id) setSelected(response.id ?? response.database!.id); setCreating(false); }}><Field label="Name"><input name="name" required autoFocus maxLength={160} /></Field></AsyncForm></Modal> : null}
  </section>;
}
