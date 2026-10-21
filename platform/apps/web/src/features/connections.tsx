import { useEffect, useState } from "react";
import {
  Cable,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  api,
  date,
  errorMessage,
  providerNames,
  send,
  useResource,
  type List,
} from "../api";
import { useWorkspace } from "../workspace";
import { Icon, Switch } from "../components/controls";
import {
  AsyncForm,
  Card,
  Confirm,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  PageHeader,
  Status,
} from "../components/ui";
type Account = {
  id: string;
  type: "subscription" | "api_key";
  provider: string;
  label: string;
  status: string;
  enabled: boolean;
  available?: boolean;
  priority?: number;
  successes?: number;
  failures?: number;
  nextRetryAt?: string;
  lastRefreshAt?: string;
};
type OAuth = {
  id: string;
  provider: string;
  status: string;
  message?: string;
  flow: "device" | "manual_code" | null;
  url?: string;
  userCode?: string;
  expiresAt: string;
  interval?: number;
};
const names = providerNames;
const warning =
  "Using a Claude subscription through this third-party proxy may result in Anthropic restricting, suspending, or terminating your account. Continued access is not guaranteed.";
export function ConnectionsPage() {
  const { org } = useWorkspace();
  const base = `/enterprise/api/organizations/${org.id}/inference`;
  const accounts = useResource<{
    configured: boolean;
    items: Account[];
    notice?: string;
  }>(`${base}/accounts`);
  const usage = useResource<
    List<{ provider: string; successes: number; failures: number }> & {
      observedAt?: string;
    }
  >(`${base}/usage`);
  const models = useResource<
    List<{ id: string; name: string; provider: string }>
  >(`${base}/models`);
  const signins = useResource<List<OAuth>>(`${base}/oauth`);
  const [resuming, setResuming] = useState<OAuth>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account>();
  const [removing, setRemoving] = useState<Account>();
  const [error, setError] = useState("");
  function reload() {
    accounts.reload();
    usage.reload();
    models.reload();
    signins.reload();
  }
  const providers = [
    ...new Set([
      ...Object.keys(names),
      ...(accounts.data?.items.map((a) => a.provider) ?? []),
    ]),
  ]
    .map((provider) => ({
      provider,
      groups: (["subscription", "api_key"] as const)
        .map((type) => ({
          type,
          items: (accounts.data?.items ?? [])
            .filter((a) => a.provider === provider && a.type === type)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
        }))
        .filter((group) => group.items.length),
    }))
    .filter((entry) => entry.groups.length);
  return (
    <section className="settings-page connections-page">
      <PageHeader
        title="Connections"
        description="Manage the inference accounts available to your organization."
        actions={
          <>
            <button
              className="icon-button"
              aria-label="Refresh connections"
              title="Refresh connections"
              onClick={reload}
            >
              <Icon icon={RefreshCw} size={16} weight="control" />
            </button>
            <button
              className="primary"
              onClick={() => {
                setResuming(undefined);
                setAdding(true);
              }}
            >
              <Icon icon={Plus} size={14} weight="control" />
              Add connection
            </button>
          </>
        }
      />
      <ErrorNotice message={signins.error} />
      {signins.data?.items
        .filter((s) =>
          [
            "starting",
            "pending",
            "cancelling",
            "interrupted",
            "expired",
            "denied",
            "error",
          ].includes(s.status),
        )
        .map((s) => (
          <div className="setting-row notice" key={s.id}>
            <Status value={s.status} />
            <div>
              <strong>{names[s.provider] ?? s.provider} sign-in</strong>
              <small>{s.message}</small>
            </div>
            <button
              className="secondary"
              onClick={() => {
                setResuming(s);
                setAdding(true);
              }}
            >
              View sign-in
            </button>
          </div>
        ))}
      <ErrorNotice message={error} />
      <Card
        title="Model providers"
        detail="Subscription sign-ins and API keys remain separate. Higher priorities are tried first; equal priorities share requests."
      >
        <ErrorNotice
          message={accounts.error ? `Connections unavailable: ${accounts.error}` : ""}
          onRetry={accounts.reload}
        />
        {accounts.loading ? (
          <Loading label={accounts.data ? "Refreshing connections…" : "Loading connections…"} />
        ) : null}
        {accounts.data?.notice &&
        accounts.data.items.some(
          (account) =>
            account.provider === "anthropic" && account.type === "subscription",
        ) ? (
          <p className="muted">{accounts.data.notice}</p>
        ) : null}
        {providers.length ? (
          providers.map(({ provider, groups }) => (
            <details open className="settings-disclosure" key={provider}>
              <summary>
                <Icon icon={ChevronDown} size={12} weight="control" className="disclosure-chevron" />
                <span>{names[provider] ?? provider}</span>
              </summary>
              <div className="settings-disclosure-content">
                {groups.map(({ type, items }) => {
                  const content = (
                    <div className="settings-disclosure-content connection-list">
                      {items.map((a) => (
                        <div className="connection-row" key={a.id}>
                          <Icon icon={type === "subscription" ? Cable : KeyRound} size={16} />
                          <div className="connection-name">
                            <strong>{a.label}</strong>
                            <small>
                              Priority {a.priority ?? 0}
                              {a.nextRetryAt
                                ? ` · Available after ${date(a.nextRetryAt)}`
                                : ""}
                            </small>
                          </div>
                          <Status value={a.enabled ? a.status : "disabled"} />
                          <div className="row-actions">
                            <button
                              className="text-button"
                              aria-label={`Manage ${a.label}`}
                              onClick={() => setEditing(a)}
                            >
                              Manage
                            </button>
                            {a.type === "subscription" ? (
                              <button
                                className="icon-button small"
                                aria-label={`Refresh ${a.label}`}
                                title={`Refresh ${a.label}`}
                                onClick={async () => {
                                  try {
                                    await send(
                                      `${base}/accounts/${encodeURIComponent(a.id)}/refresh`,
                                      {},
                                    );
                                    reload();
                                  } catch (e) {
                                    setError(errorMessage(e));
                                  }
                                }}
                              >
                                <Icon icon={RefreshCw} size={14} weight="control" />
                              </button>
                            ) : null}
                            <button
                              className="text-button danger"
                              aria-label={`Remove ${a.label}`}
                              onClick={() => setRemoving(a)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                  // Native API-only providers have no redundant credential
                  // disclosure. Preserve grouping if the API supplies both types.
                  return ["openai", "anthropic", "xai"].includes(provider) || groups.length > 1 ? (
                    <details open className="settings-disclosure" key={type}>
                      <summary>
                        <Icon icon={ChevronDown} size={12} weight="control" className="disclosure-chevron" />
                        <span>{type === "subscription" ? "Subscriptions" : "API keys"}</span>
                      </summary>
                      {content}
                    </details>
                  ) : <div key={type}>{content}</div>;
                })}
              </div>
            </details>
          ))
        ) : !accounts.loading && !accounts.error && accounts.data ? (
          <Empty
            title="No connections yet"
            action={
              <button
                className="primary"
                onClick={() => {
                  setResuming(undefined);
                  setAdding(true);
                }}
              >
                Add connection
              </button>
            }
          >
            Connect a subscription or API key so your team can work with
            agents.
          </Empty>
        ) : null}
      </Card>
      <Card title="Available models">
        <ErrorNotice
          message={models.error ? `Models unavailable: ${models.error}` : ""}
          onRetry={models.reload}
        />
        {models.loading ? (
          <Loading label={models.data ? "Refreshing models…" : "Loading models…"} />
        ) : null}
        {models.data?.items.length ? (
          <div className="model-list">
            {models.data.items.map((m) => (
              <div key={`${m.provider}:${m.id}`}>
                <strong>{m.name || m.id}</strong>
                <small>{names[m.provider] ?? m.provider}</small>
              </div>
            ))}
          </div>
        ) : !models.loading && !models.error && models.data ? (
          <p className="muted">
            Models will appear when a connected provider makes them available.
          </p>
        ) : null}
      </Card>
      <Card
        title="Observed usage"
        detail="Requests recorded by the inference gateway. These counts are not a billing balance or remaining subscription allowance."
      >
        <ErrorNotice
          message={usage.error ? `Usage unavailable: ${usage.error}` : ""}
          onRetry={usage.reload}
        />
        {usage.loading ? (
          <Loading label={usage.data ? "Refreshing usage…" : "Loading usage…"} />
        ) : null}
        {usage.data?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="numeric">Successful requests</th>
                  <th className="numeric">Failed requests</th>
                </tr>
              </thead>
              <tbody>
                {usage.data.items.map((u) => (
                  <tr key={u.provider}>
                    <td>{names[u.provider] ?? u.provider}</td>
                    <td className="numeric">{u.successes}</td>
                    <td className="numeric">{u.failures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !usage.loading && !usage.error && usage.data ? (
          <p className="muted">No request usage recorded.</p>
        ) : null}
      </Card>
      {adding ? (
        <AddConnection
          initial={resuming}
          base={base}
          onClose={() => {
            setAdding(false);
            setResuming(undefined);
            signins.reload();
          }}
          onSaved={() => {
            reload();
            setAdding(false);
          }}
        />
      ) : null}
      {editing ? (
        <Modal title="Manage connection" onClose={() => setEditing(undefined)}>
          <AsyncForm
            onCancel={() => setEditing(undefined)}
            onSubmit={async (d) => {
              await send(
                `${base}/accounts/${encodeURIComponent(editing.id)}`,
                {
                  ...(editing.type === "api_key"
                    ? { label: d.get("label") }
                    : {}),
                  enabled: d.get("enabled") === "on",
                  priority: Number(d.get("priority")),
                },
                "PATCH",
              );
              reload();
              setEditing(undefined);
            }}
          >
            {editing.type === "api_key" ? (
              <Field label="Name">
                <input name="label" defaultValue={editing.label} required />
              </Field>
            ) : (
              <p>{editing.label}</p>
            )}
            <Field
              label="Priority"
              hint="Higher numbers are preferred. Accounts with the same priority share requests."
            >
              <input
                name="priority"
                type="number"
                min={-1000}
                max={1000}
                defaultValue={editing.priority ?? 0}
              />
            </Field>
            <Switch name="enabled" defaultChecked={editing.enabled}>
              Enabled
            </Switch>
          </AsyncForm>
        </Modal>
      ) : null}
      {removing ? (
        <Confirm
          title="Remove connection?"
          label="Remove connection"
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await api(`${base}/accounts/${encodeURIComponent(removing.id)}`, {
              method: "DELETE",
            });
            reload();
            setRemoving(undefined);
          }}
        >
          Your organization will stop using “{removing.label}”.
        </Confirm>
      ) : null}
    </section>
  );
}
function AddConnection({
  initial,
  base,
  onClose,
  onSaved,
}: {
  base: string;
  onClose: () => void;
  onSaved: () => void;
  initial?: OAuth;
}) {
  const [type, setType] = useState(initial ? "subscription" : "api_key");
  const [provider, setProvider] = useState(initial?.provider ?? "openai");
  const [oauth, setOauth] = useState<OAuth | undefined>(initial);
  return (
    <Modal title="Add connection" onClose={onClose}>
      {oauth ? (
        <OAuthFlow
          base={base}
          oauth={oauth}
          onRetry={() => setOauth(undefined)}
          onSaved={onSaved}
          onClose={onClose}
        />
      ) : (
        <AsyncForm
          submitLabel={type === "subscription" ? "Begin sign in" : "Connect"}
          onCancel={onClose}
          onSubmit={async (d) => {
            if (type === "subscription") {
              setOauth(
                await send<OAuth>(`${base}/oauth`, {
                  provider,
                  acceptedRisk: d.get("acceptedRisk") === "on",
                }),
              );
            } else {
              await send(`${base}/accounts`, {
                provider,
                label: d.get("label"),
                apiKey: d.get("apiKey"),
                ...(provider === "custom" ? { baseUrl: d.get("baseUrl") } : {}),
              });
              onSaved();
            }
          }}
        >
          <Field label="Connection type">
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setProvider("openai");
              }}
            >
              <option value="api_key">API key</option>
              <option value="subscription">Subscription</option>
            </select>
          </Field>
          <Field label="Provider">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {Object.entries(names)
                .filter(
                  ([key]) =>
                    type === "api_key" ||
                    ["openai", "anthropic", "xai"].includes(key),
                )
                .map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
            </select>
          </Field>
          {type === "api_key" ? (
            <>
              <Field label="Connection name">
                <input
                  name="label"
                  required
                  maxLength={160}
                  placeholder="Organization account"
                />
              </Field>
              {provider === "custom" ? (
                <Field label="Server URL">
                  <input
                    name="baseUrl"
                    type="url"
                    required
                    placeholder="https://provider.example/v1"
                  />
                </Field>
              ) : null}
              <Field label="API key">
                <input
                  name="apiKey"
                  type="password"
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </>
          ) : (
            <p className="muted">
              You will complete sign-in with the provider. The connection is
              managed centrally for this organization.
            </p>
          )}
          {provider === "anthropic" && type === "subscription" ? (
            <>
              <div className="notice warning">{warning}</div>
              {/* An explicit risk acknowledgement stays a checkbox. */}
              <label className="checkbox">
                <input name="acceptedRisk" type="checkbox" required />
                <span>I understand and accept this account risk.</span>
              </label>
            </>
          ) : null}
        </AsyncForm>
      )}
    </Modal>
  );
}
function OAuthFlow({
  base,
  oauth,
  onSaved,
  onClose,
  onRetry,
}: {
  base: string;
  oauth: OAuth;
  onSaved: () => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [current, setCurrent] = useState(oauth),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const active = ["starting", "pending", "cancelling"].includes(current.status);
  useEffect(() => {
    let disposed = false;
    let timeout: number | undefined;
    const controller = new AbortController();
    async function poll() {
      try {
        const result = await api<OAuth>(
          `${base}/oauth/${encodeURIComponent(oauth.id)}`,
          { signal: controller.signal },
        );
        if (disposed) return;
        setCurrent(result);
        setError("");
        if (["starting", "pending", "cancelling"].includes(result.status))
          timeout = window.setTimeout(poll, 1500);
      } catch (e) {
        if (!disposed) setError(errorMessage(e));
      }
    }
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [base, oauth.id, retry]);
  return (
    <div className="oauth-flow">
      {active && current.flow === "device" ? (
        <>
          <p>
            Open the provider’s sign-in page and enter this one-time code there.
            This server will finish connecting after you approve.
          </p>
          <div className="device-code">
            <span>Device code</span>
            <strong>{current.userCode}</strong>
          </div>
          {current.provider === "openai" ? (
            <p className="muted">
              Device-code sign-in is in beta. You may need to enable it in your
              ChatGPT security settings or ask your workspace administrator.
            </p>
          ) : null}
        </>
      ) : active && current.flow === "manual_code" ? (
        <p>
          Sign in with Claude in your browser. Copy the authorization code it
          shows, then return here and paste it below.
        </p>
      ) : null}
      {active && current.url ? (
        <a
          className="primary button-link"
          href={current.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Continue to provider{" "}
          <Icon icon={ExternalLink} size={14} weight="control" />
        </a>
      ) : null}
      {active ? (
        <p className="muted">
          Complete by {date(current.expiresAt)}. You can close this dialog and
          resume from Connections.
        </p>
      ) : null}
      <div role="status" className="oauth-status">
        <Status value={current.status} />
        {current.message ? <p>{current.message}</p> : null}
      </div>
      <ErrorNotice message={error} />
      {error ? (
        <button className="secondary" onClick={() => setRetry(retry + 1)}>
          Check sign-in status
        </button>
      ) : null}
      {current.status === "pending" && current.flow === "manual_code" ? (
        <AsyncForm
          submitLabel="Complete sign in"
          onSubmit={async (d) => {
            await send(`${base}/oauth/${encodeURIComponent(oauth.id)}/code`, {
              code: d.get("code"),
            });
            setRetry(retry + 1);
          }}
        >
          <Field
            label="Authorization code"
            hint="Paste only the code from the provider’s sign-in page."
          >
            <input
              name="code"
              type="password"
              required
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </AsyncForm>
      ) : null}
      {active ? (
        <button
          className="text-button"
          onClick={async () => {
            try {
              const result = await api<OAuth>(
                `${base}/oauth/${encodeURIComponent(oauth.id)}`,
                { method: "DELETE" },
              );
              if (result.status === "complete") {
                setCurrent(result);
                return;
              }
              onClose();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          Cancel sign in
        </button>
      ) : current.status === "complete" ? (
        <button className="primary" onClick={onSaved}>
          Done
        </button>
      ) : (
        <button className="primary" onClick={onRetry}>
          Start a new sign-in
        </button>
      )}
    </div>
  );
}
