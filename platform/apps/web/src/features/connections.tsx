import { useEffect, useState } from "react";
import { Cable, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { api, date, errorMessage, send, useResource, type List } from "../api";
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
type OAuth = { id: string; url: string; userCode?: string; expiresAt: string };
const names: Record<string, string> = {
  openai: "OpenAI / ChatGPT",
  anthropic: "Anthropic / Claude",
  xai: "xAI / Grok",
  openrouter: "OpenRouter",
  custom: "Custom provider",
};
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
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account>();
  const [removing, setRemoving] = useState<Account>();
  const [error, setError] = useState("");
  function reload() {
    accounts.reload();
    usage.reload();
    models.reload();
  }
  return (
    <section>
      <PageHeader
        title="Connections"
        description="Manage the inference accounts available to your organization."
        actions={
          <>
            <button
              className="icon-button"
              aria-label="Refresh connections"
              onClick={reload}
            >
              <RefreshCw size={18} />
            </button>
            <button className="primary" onClick={() => setAdding(true)}>
              <Plus size={17} />
              Add connection
            </button>
          </>
        }
      />
      <ErrorNotice
        message={accounts.error || usage.error || models.error || error}
      />
      {accounts.data?.notice &&
      accounts.data.items.some(
        (account) =>
          account.provider === "anthropic" && account.type === "subscription",
      ) ? (
        <p className="muted">{accounts.data.notice}</p>
      ) : null}
      {accounts.loading && !accounts.data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          {accounts.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="item-link">
                        <Cable size={18} />
                        <div>
                          <strong>{a.label}</strong>
                          <small>
                            {a.type === "subscription"
                              ? "Subscription"
                              : "API key"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>{names[a.provider] ?? a.provider}</td>
                    <td>
                      <Status value={a.enabled ? a.status : "disabled"} />
                      {a.nextRetryAt ? (
                        <small>Available after {date(a.nextRetryAt)}</small>
                      ) : null}
                    </td>
                    <td>{a.priority ?? 0}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="text-button"
                          onClick={() => setEditing(a)}
                        >
                          Manage
                        </button>
                        {a.type === "subscription" ? (
                          <button
                            className="icon-button"
                            aria-label={`Refresh ${a.label}`}
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
                            <RefreshCw size={16} />
                          </button>
                        ) : null}
                        <button
                          className="text-button danger"
                          onClick={() => setRemoving(a)}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              title="No connections yet"
              action={
                <button className="primary" onClick={() => setAdding(true)}>
                  Add connection
                </button>
              }
            >
              Connect a subscription or API key so your team can work with
              agents.
            </Empty>
          )}
        </div>
      )}
      <section className="section-block">
        <h2>Available models</h2>
        {models.data?.items.length ? (
          <div className="model-list">
            {models.data.items.map((m) => (
              <div key={`${m.provider}:${m.id}`}>
                <strong>{m.name || m.id}</strong>
                <small>{names[m.provider] ?? m.provider}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            Models will appear when a connected provider makes them available.
          </p>
        )}
      </section>
      <section className="section-block">
        <h2>Observed usage</h2>
        <p className="muted">
          Requests recorded by the inference gateway. These counts are not a
          billing balance or remaining subscription allowance.
        </p>
        {usage.data?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Successful requests</th>
                  <th>Failed requests</th>
                </tr>
              </thead>
              <tbody>
                {usage.data.items.map((u) => (
                  <tr key={u.provider}>
                    <td>{names[u.provider] ?? u.provider}</td>
                    <td>{u.successes}</td>
                    <td>{u.failures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No request usage recorded.</p>
        )}
      </section>
      {adding ? (
        <AddConnection
          base={base}
          onClose={() => setAdding(false)}
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
            <label className="checkbox">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={editing.enabled}
              />
              Enabled
            </label>
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
  base,
  onClose,
  onSaved,
}: {
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState("api_key");
  const [provider, setProvider] = useState("openai");
  const [oauth, setOauth] = useState<OAuth>();
  return (
    <Modal title="Add connection" onClose={onClose}>
      {oauth ? (
        <OAuthFlow
          base={base}
          oauth={oauth}
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
              <label className="checkbox">
                <input name="acceptedRisk" type="checkbox" required />I
                understand and accept this account risk.
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
}: {
  base: string;
  oauth: OAuth;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("pending");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let timeout: number;
    async function poll() {
      try {
        const result = await api<{ status: string; message?: string }>(
          `${base}/oauth/${encodeURIComponent(oauth.id)}`,
        );
        if (cancelled) return;
        setStatus(result.status);
        setMessage(result.message ?? "");
        if (result.status === "complete") {
          onSaved();
          return;
        }
        if (result.status === "pending")
          timeout = window.setTimeout(poll, 2500);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [base, oauth.id]);
  return (
    <div className="oauth-flow">
      <p>
        Open the provider’s sign-in page, complete the steps, then return here.
      </p>
      {oauth.userCode ? (
        <div className="device-code">
          <span>Device code</span>
          <strong>{oauth.userCode}</strong>
        </div>
      ) : null}
      <a
        className="primary button-link"
        href={oauth.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        Continue to provider <ExternalLink size={16} />
      </a>
      <p className="muted">Expires {date(oauth.expiresAt)}</p>
      <div role="status">
        <Status value={status} />
        {message ? <p>{message}</p> : null}
      </div>
      <ErrorNotice message={error} />
      {status === "pending" ? (
        <details>
          <summary>Complete with a callback URL</summary>
          <AsyncForm
            submitLabel="Complete sign in"
            onSubmit={async (d) => {
              await send(
                `${base}/oauth/${encodeURIComponent(oauth.id)}/callback`,
                { redirectUrl: d.get("redirectUrl") },
              );
            }}
          >
            <Field
              label="Callback URL"
              hint="If the provider redirects to a page that cannot open, paste that complete URL here."
            >
              <input
                name="redirectUrl"
                type="url"
                required
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </AsyncForm>
        </details>
      ) : null}
      <button
        className="text-button"
        onClick={async () => {
          try {
            await api(`${base}/oauth/${encodeURIComponent(oauth.id)}`, {
              method: "DELETE",
            });
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        Cancel sign in
      </button>
    </div>
  );
}
