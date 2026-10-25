import { useState } from "react";
import { Plus } from "lucide-react";
import { send, useResource, type List, type Organization, type User } from "../api";
import { Icon, SearchField, Switch } from "../components/controls";
import { AsyncForm, BackLink, Card, Confirm, Empty, ErrorNotice, Field, Loading, Modal, PageHeader, Status, Success } from "../components/ui";

type Account = User & { createdAt: string; memberships: { orgId: string; organizationName: string; role: string }[] };
export function AccountsPage() {
  const accounts = useResource<List<Account>>("/enterprise/api/accounts");
  const organizations = useResource<List<Organization>>("/enterprise/api/organizations");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activationUrl, setActivationUrl] = useState("");
  const items = accounts.data?.items.filter(account => `${account.name} ${account.email}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const managed = accounts.data?.items.find(account => account.id === managing);
  async function update(account: Account, enabled: boolean) {
    try { await send(`/enterprise/api/accounts/${account.id}`, { enabled }, "PATCH"); accounts.reload(); setError(""); }
    catch (e) { setError((e as Error).message); }
  }
  return <section className="platform-page">
    <BackLink to="/" label="Back to Admin" />
    <PageHeader title="Accounts" description="Manage accounts across the platform." actions={<button className="primary" onClick={() => setAdding(true)}><Icon icon={Plus} size={14} />Create account</button>} />
    <SearchField label="Search accounts" value={query} onChange={setQuery} placeholder="Search accounts…" />
    <ErrorNotice message={error || accounts.error} onRetry={accounts.reload} />
    {notice ? <Success>{notice}</Success> : null}
    {activationUrl ? <Field label="Invitation link" hint="Copy this link to share directly with the invitee."><input readOnly value={activationUrl} /></Field> : null}
    {accounts.loading && !accounts.data ? <Loading /> : <div className="table-wrap"><table><thead><tr><th>Account</th><th>Organizations</th><th>Status</th><th>Enabled</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{items.map(account => <tr key={account.id}>
      <td><strong>{account.name || account.email}</strong><small>{account.email}</small></td>
      <td>{account.role === "owner" ? "Platform owner" : account.memberships.map(m => `${m.organizationName} · ${m.role}`).join(", ") || "No memberships"}</td>
      <td><Status value={account.invitationPending ? "pending" : account.enabled ? "active" : "disabled"} /></td>
      <td><Switch checked={account.enabled} disabled={account.role === "owner"} onChange={event => void update(account, event.target.checked)}>Enable {account.name || account.email}</Switch></td>
      <td><div className="row-actions">{account.role !== "owner" ? <button className="text-button" onClick={() => setManaging(account.id)}>Manage memberships</button> : null}{account.invitationPending ? <button className="text-button" onClick={async () => { try { const result = await send<{ activationUrl?: string }>(`/enterprise/api/accounts/${account.id}/invitations`, {}); setActivationUrl(result.activationUrl ?? ""); setNotice("Invitation renewed."); } catch (e) { setError((e as Error).message); } }}>Resend invitation</button> : null}</div></td>
    </tr>)}</tbody></table>{!items.length && accounts.data ? <Empty title="No matching accounts" /> : null}</div>}
    {adding ? <Modal title="Create account" onClose={() => setAdding(false)}><AsyncForm submitLabel="Create account" onCancel={() => setAdding(false)} onSubmit={async data => {
      const result = await send<{ activationUrl?: string }>("/enterprise/api/accounts", { name: data.get("name"), email: data.get("email"), orgId: data.get("orgId") || undefined, role: data.get("role") });
      setActivationUrl(result.activationUrl ?? ""); setNotice("Account created."); setAdding(false); accounts.reload();
    }}>
      <Field label="Name"><input name="name" required autoFocus /></Field><Field label="Email"><input name="email" type="email" required /></Field>
      <Field label="Organization"><select name="orgId"><option value="">Add membership later</option>{organizations.data?.items.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></Field>
      <Field label="Organization role"><select name="role"><option value="member">Member</option><option value="admin">Administrator</option></select></Field>
    </AsyncForm></Modal> : null}
    {managed ? <AccountMemberships account={managed} organizations={organizations.data?.items ?? []} organizationsError={organizations.error} onClose={() => setManaging("")} onSaved={accounts.reload} /> : null}
  </section>;
}

function AccountMemberships({ account, organizations, organizationsError, onClose, onSaved }: {
  account: Account;
  organizations: Organization[];
  organizationsError: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState("");
  const [removing, setRemoving] = useState<Account["memberships"][number]>();
  const available = organizations.filter(org => !account.memberships.some(membership => membership.orgId === org.id));
  const membershipPath = (orgId: string) => `/enterprise/api/organizations/${orgId}/members/${account.id}`;
  return <Modal title={`Memberships for ${account.name || account.email}`} onClose={onClose}>
    <p>{account.email}</p>
    <ErrorNotice message={error || organizationsError} />
    {account.memberships.map(membership => <div className="setting-row account-membership" key={membership.orgId}>
      <strong>{membership.organizationName}</strong>
      <Field label={`Role in ${membership.organizationName}`}><select value={membership.role} disabled={busy} onChange={async event => {
        setBusy(true); setError("");
        try { await send(membershipPath(membership.orgId), { role: event.target.value }, "PATCH"); onSaved(); }
        catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}><option value="member">Member</option><option value="admin">Administrator</option></select></Field>
      <button className="text-button danger" disabled={busy} aria-label={`Remove ${membership.organizationName} membership`} onClick={() => setRemoving(membership)}>Remove</button>
    </div>)}
    {!account.memberships.length ? <p className="muted">This account has no organization memberships.</p> : null}
    {available.length ? <AsyncForm submitLabel="Add membership" onSubmit={async form => {
      const result = await send<{ activationUrl?: string }>("/enterprise/api/accounts", { email: account.email, name: account.name, orgId: form.get("orgId"), role: form.get("role") });
      setInvitation(result.activationUrl ?? ""); onSaved();
    }}>
      <Field label="Add to organization"><select name="orgId" required defaultValue=""><option value="" disabled>Choose an organization</option>{available.map(org => <option value={org.id} key={org.id}>{org.name}</option>)}</select></Field>
      <Field label="Organization role"><select name="role" defaultValue="member"><option value="member">Member</option><option value="admin">Administrator</option></select></Field>
    </AsyncForm> : null}
    {invitation ? <Field label="Renewed invitation link" hint="The pending account keeps the same identity. This link replaces its earlier invitation."><input readOnly value={invitation} /></Field> : null}
    {removing ? <Confirm title="Remove membership?" label="Remove membership" onClose={() => setRemoving(undefined)} onConfirm={async () => {
      await send(membershipPath(removing.orgId), {}, "DELETE"); setRemoving(undefined); onSaved();
    }}>Remove {account.name || account.email} from {removing.organizationName}? Their access to this organization and its workspaces will end.</Confirm> : null}
  </Modal>;
}
export function PlatformSettings() {
  const settings = useResource<{ owner: { name?: string; email?: string }; organizations: number; accounts: number; hosts: Array<{ id: string; name: string; status?: string }> | number }>("/enterprise/api/platform/settings");
  return <section className="platform-page settings-page"><BackLink to="/" label="Back to Admin" /><PageHeader title="Platform settings" description="Platform ownership and workspace infrastructure." /><ErrorNotice message={settings.error} onRetry={settings.reload} />{settings.loading ? <Loading /> : null}{settings.data ? <>
    <Card title="Platform owner"><strong>{settings.data.owner.name}</strong><p>{settings.data.owner.email}</p></Card>
    <Card title="Platform"><div className="setting-row"><span>Organizations</span><strong>{settings.data.organizations}</strong></div><div className="setting-row"><span>Accounts</span><strong>{settings.data.accounts}</strong></div></Card>
    <Card title="Workspace hosts">{Array.isArray(settings.data.hosts) ? settings.data.hosts.map(host => <div className="setting-row" key={host.id}><strong>{host.name}</strong>{host.status ? <Status value={host.status} /> : null}</div>) : <p>{settings.data.hosts} configured hosts</p>}</Card>
  </> : null}</section>;
}
