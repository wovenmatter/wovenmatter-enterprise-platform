import { discoverProviderModels } from "./discovery.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppContext, User } from "../context.js";
import {
  CLAUDE_SUBSCRIPTION_NOTICE,
  InferenceError,
  ProxyClient,
  count,
  object,
  text,
  type ProxyEndpoint,
} from "./proxy-client.js";
export interface ProxyRegistry {
  resolve(organizationId: string): Promise<ProxyEndpoint | undefined>;
  ensure?(organizationId: string): Promise<ProxyEndpoint>;
}
export interface RunScope {
  orgId: string;
  projectId: string;
  userId: string;
  runId: string;
  model: string;
  harness: string;
  conversationId?: string;
}
export interface InferenceOptions {
  registry: ProxyRegistry;
  canUseRun: (scope: RunScope) => Promise<boolean>;
  runtimeApiOrigin?: string;
  fetcher?: typeof fetch;
  discoverModels?: typeof discoverProviderModels;
  /** Operator-approved additional origins, including self-hosted model endpoints. */
  customProviderOrigins?: string[];
}
export type InferenceModel = {
  id: string;
  name: string;
  provider: string;
};
type ApiProvider = "openai" | "anthropic" | "openrouter" | "xai" | "custom";
type SubscriptionProvider = "openai" | "anthropic" | "xai";
interface ApiAccount {
  id: string;
  org_id: string;
  provider: ApiProvider;
  label: string;
  group_family: string;
  state: string;
  created_at: string;
}
interface OAuthRow {
  id: string;
  org_id: string;
  user_id: string;
  provider: SubscriptionProvider;
  state: string;
  expires_at: string;
  status: string;
}
interface GatewayRow {
  org_id: string;
  project_id: string;
  user_id: string;
  run_id: string;
  expires_at: string;
  revoked: number;
  model: string;
  harness: string;
  conversation_id: string | null;
}
const providerNames: Record<SubscriptionProvider, string> = {
  openai: "codex",
  anthropic: "claude",
  xai: "xai",
};
const apiDefaults: Record<
  ApiProvider,
  {
    family: string;
    url: string;
  }
> = {
  openai: {
    family: "codex",
    url: "https://api.openai.com/v1",
  },
  anthropic: {
    family: "claude",
    url: "https://api.anthropic.com",
  },
  openrouter: {
    family: "openai-compatibility",
    url: "https://openrouter.ai/api/v1",
  },
  xai: {
    family: "xai",
    url: "https://api.x.ai/v1",
  },
  custom: {
    family: "openai-compatibility",
    url: "",
  },
};
function hash(input: string) {
  return createHash("sha256").update(input).digest("hex");
}
function validName(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 160 ||
    /[\u0000-\u001f]/.test(input)
  )
    throw new InferenceError(
      400,
      "invalid_label",
      "Enter a name of at most 160 characters.",
    );
  return input.trim();
}
function familyProvider(value: unknown): string {
  const name = String(value ?? "").toLowerCase();
  if (name === "codex" || name === "openai") return "openai";
  if (name === "claude" || name === "anthropic") return "anthropic";
  if (name === "xai" || name === "grok") return "xai";
  return name === "openrouter" ? "openrouter" : "custom";
}
/** A single API process owns proxy configuration writes; worker jobs call this owner. */
export class InferenceService {
  readonly proxy: ProxyClient;
  private readonly mutations = new Map<string, Promise<unknown>>();
  constructor(
    readonly ctx: AppContext,
    readonly options: InferenceOptions,
  ) {
    this.proxy = new ProxyClient(
      (id) => options.registry.resolve(id),
      options.fetcher,
    );
  }
  async initialize() {
    await this.ctx.db.migrate(
      "inference-v1",
      `
      CREATE TABLE inference_api_accounts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL, label TEXT NOT NULL, group_family TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX inference_api_accounts_org ON inference_api_accounts(org_id);
      CREATE TABLE inference_oauth_sessions (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL);
      CREATE INDEX inference_oauth_sessions_expiry ON inference_oauth_sessions(expires_at);
      CREATE TABLE inference_gateway_tokens (token_hash TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), run_id TEXT NOT NULL, conversation_id TEXT, model TEXT NOT NULL, harness TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX inference_gateway_tokens_run ON inference_gateway_tokens(run_id);
    `,
    );
    await this.ctx.db.migrate(
      "project-egress-v1",
      "CREATE TABLE project_egress_capabilities(project_id TEXT PRIMARY KEY REFERENCES projects(id),org_id TEXT NOT NULL REFERENCES organizations(id),host_id TEXT NOT NULL,token_hash TEXT NOT NULL);",
    );
  }
  /** Project-owned scheduled scripts receive public-network authority only. */
  async issueProjectEgress(
    spec: import("../../../../packages/runtime/src/types.js").ProjectRuntimeSpec,
  ): Promise<string> {
    const row = await this.ctx.db.get(
      "SELECT id FROM projects WHERE id=? AND org_id=? AND host_id=? AND status<>'purged'",
      [spec.projectId, spec.organizationId, spec.hostId],
    );
    if (!row)
      throw new InferenceError(
        403,
        "project_unavailable",
        "Project placement is unavailable.",
      );
    const token = `wme_schedule_${randomBytes(32).toString("base64url")}`;
    await this.ctx.db.run(
      "INSERT INTO project_egress_capabilities(project_id,org_id,host_id,token_hash) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET token_hash=excluded.token_hash,host_id=excluded.host_id",
      [spec.projectId, spec.organizationId, spec.hostId, hash(token)],
    );
    return token;
  }
  async authorizeEgress(
    projectId: string,
    token: string,
  ): Promise<import("../egress/index.js").EgressScope> {
    if (!token.startsWith("wme_schedule_"))
      return this.authorizeGateway(projectId, token);
    if (!/^wme_schedule_[a-zA-Z0-9_-]{43}$/.test(token))
      throw new InferenceError(
        403,
        "project_unavailable",
        "Project network access is unavailable.",
      );
    const row = await this.ctx.db.get<any>(
      "SELECT c.* FROM project_egress_capabilities c JOIN projects p ON p.id=c.project_id AND p.org_id=c.org_id AND p.host_id=c.host_id WHERE c.project_id=? AND c.token_hash=? AND p.status='ready' AND p.deleted_at IS NULL",
      [projectId, hash(token)],
    );
    if (!row)
      throw new InferenceError(
        403,
        "project_unavailable",
        "Project network access is unavailable.",
      );
    return {
      orgId: row.org_id,
      projectId,
      userId: "project-scheduler",
      runId: row.token_hash,
    };
  }
  private async locked<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(orgId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    this.mutations.set(orgId, current);
    try {
      return await current;
    } finally {
      if (this.mutations.get(orgId) === current) this.mutations.delete(orgId);
    }
  }
  async ensure(orgId: string) {
    if (this.options.registry.ensure) await this.options.registry.ensure(orgId);
    return this.proxy.endpoint(orgId);
  }
  private async rawAccounts(orgId: string): Promise<Record<string, unknown>[]> {
    const data = object(
      await this.proxy.request(orgId, "/v8/management/credentials"),
    );
    return Array.isArray(data.files) ? data.files.map(object) : [];
  }
  private subscriptionId(orgId: string, entry: Record<string, unknown>) {
    return `sub_${hash(`${orgId}\0${String(entry.name)}\0${String(entry.auth_index ?? "")}`).slice(0, 32)}`;
  }
  async accounts(orgId: string) {
    const endpoint = await this.options.registry.resolve(orgId);
    if (!endpoint)
      return {
        configured: false,
        items: [],
        notice: CLAUDE_SUBSCRIPTION_NOTICE,
      };
    const raw = await this.rawAccounts(orgId);
    const api = await this.ctx.db.all<ApiAccount>(
      "SELECT * FROM inference_api_accounts WHERE org_id=? ORDER BY created_at",
      [orgId],
    );
    const proxyConfig = api.length
      ? object(await this.proxy.request(orgId, "/v8/management/config"))
      : {};
    const subscriptions = raw
      .filter(
        (item) =>
          item.runtime_only !== true &&
          ["codex", "claude", "anthropic", "xai"].includes(
            String(item.provider ?? item.type),
          ),
      )
      .map((item) => ({
        id: this.subscriptionId(orgId, item),
        type: "subscription",
        provider: familyProvider(item.provider ?? item.type),
        label:
          validDisplayEmail(item.email) ??
          `${familyProvider(item.provider ?? item.type)} subscription`,
        enabled: item.disabled !== true,
        available: item.disabled !== true && item.unavailable !== true,
        status: ["active", "disabled", "error", "pending"].includes(
          String(item.status),
        )
          ? item.status
          : "unknown",
        priority: Number.isInteger(item.priority) ? item.priority : 0,
        successes: count(item.success),
        failures: count(item.failed),
        nextRetryAt: validDate(item.next_retry_after),
        lastRefreshAt: validDate(item.last_refresh),
      }));
    const apiDtos = api.map((item) => {
      const family = object(proxyConfig["api-keys"])[item.group_family];
      const group = (Array.isArray(family) ? family.map(object) : []).find(
        (entry) => entry.name === `wme-${item.id}`,
      );
      const disabled =
        group?.disabled === true ||
        (Array.isArray(group?.["excluded-models"]) &&
          group["excluded-models"].includes("*"));
      const keys = Array.isArray(group?.keys)
        ? group.keys.map((key) => object(key)["api-key"])
        : [];
      const runtime = raw.filter(
        (entry) => entry.runtime_only === true && keys.includes(entry.account),
      );
      return {
        id: item.id,
        type: "api_key",
        provider: item.provider,
        label: item.label,
        status: !group
          ? "needs_attention"
          : disabled
            ? "disabled"
            : item.state === "pending" || item.state === "needs_attention"
              ? "active"
              : item.state,
        enabled: !!group && !disabled,
        priority: Number.isInteger(group?.priority) ? group?.priority : 0,
        available: runtime.length
          ? runtime.some(
              (entry) => entry.unavailable !== true && entry.disabled !== true,
            )
          : undefined,
        successes: runtime.reduce(
          (sum, entry) => sum + count(entry.success),
          0,
        ),
        failures: runtime.reduce((sum, entry) => sum + count(entry.failed), 0),
        createdAt: item.created_at,
      };
    });
    return {
      configured: true,
      items: [...subscriptions, ...apiDtos],
      notice: CLAUDE_SUBSCRIPTION_NOTICE,
    };
  }
  async discover(
    user: User,
    orgId: string,
    input: {
      provider: ApiProvider;
      apiKey: string;
      baseUrl?: string;
    },
  ) {
    await this.ctx.requireOrgAdmin(user, orgId);
    if (!apiDefaults[input.provider])
      throw new InferenceError(
        400,
        "invalid_provider",
        "Choose a supported provider.",
      );
    if (
      typeof input.apiKey !== "string" ||
      input.apiKey.length < 8 ||
      input.apiKey.length > 8192 ||
      /[\r\n]/.test(input.apiKey)
    )
      throw new InferenceError(
        400,
        "invalid_api_key",
        "Enter a valid API key.",
      );
    const baseUrl =
      input.provider === "custom"
        ? input.baseUrl
        : apiDefaults[input.provider].url;
    if (!baseUrl)
      throw new InferenceError(
        400,
        "missing_base_url",
        "Enter the provider server URL.",
      );
    return {
      items: (
        await (this.options.discoverModels ?? discoverProviderModels)(
          baseUrl,
          input.apiKey,
          this.options.customProviderOrigins,
          input.provider,
        )
      ).map((id) => ({
        id,
        name: id,
        provider: input.provider,
      })),
    };
  }
  async addApiKey(
    user: User,
    orgId: string,
    input: {
      provider: ApiProvider;
      label: string;
      apiKey: string;
      baseUrl?: string;
      models?: string[];
    },
  ) {
    await this.ctx.requireOrgAdmin(user, orgId);
    const config = apiDefaults[input.provider];
    if (!config)
      throw new InferenceError(
        400,
        "invalid_provider",
        "Choose a supported provider.",
      );
    const label = validName(input.label);
    if (
      typeof input.apiKey !== "string" ||
      input.apiKey.length < 8 ||
      input.apiKey.length > 8192 ||
      /[\r\n]/.test(input.apiKey)
    )
      throw new InferenceError(
        400,
        "invalid_api_key",
        "Enter a valid API key.",
      );
    const baseUrl = input.provider === "custom" ? input.baseUrl : config.url;
    if (!baseUrl)
      throw new InferenceError(
        400,
        "missing_base_url",
        "Enter the provider server URL.",
      );
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new InferenceError(
        400,
        "invalid_base_url",
        "Enter a valid provider server URL.",
      );
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["https:", "http:"].includes(url.protocol)
    )
      throw new InferenceError(
        400,
        "invalid_base_url",
        "Enter an approved provider server URL.",
      );
    const discovered = await (
      this.options.discoverModels ?? discoverProviderModels
    )(
      baseUrl,
      input.apiKey,
      this.options.customProviderOrigins,
      input.provider,
    );
    const modelNames = input.models?.length ? input.models : discovered;
    if (modelNames.some((model) => !discovered.includes(model)))
      throw new InferenceError(
        400,
        "model_unavailable",
        "Choose models from the provider catalog.",
      );
    if (
      modelNames.length > 500 ||
      modelNames.some(
        (m) =>
          typeof m !== "string" ||
          !m.trim() ||
          m.length > 200 ||
          /[\u0000-\u001f]/.test(m),
      )
    )
      throw new InferenceError(
        400,
        "invalid_models",
        "The model list is invalid.",
      );
    if (config.family === "openai-compatibility" && !modelNames.length)
      throw new InferenceError(
        400,
        "models_required",
        "Select at least one model for this compatible provider.",
      );
    await this.ensure(orgId);
    return this.locked(orgId, async () => {
      const id = randomUUID();
      const path = `/v8/management/config/api-keys/${config.family}`;
      const existing = await this.groupList(orgId, config.family);
      await this.ctx.db.run(
        "INSERT INTO inference_api_accounts (id,org_id,provider,label,group_family,state,created_at) VALUES (?,?,?,?,?,?,?)",
        [
          id,
          orgId,
          input.provider,
          label,
          config.family,
          "pending",
          new Date().toISOString(),
        ],
      );
      const group = {
        name: `wme-${id}`,
        "base-url": baseUrl,
        "request-retry": 0,
        keys: [
          {
            "api-key": input.apiKey,
          },
        ],
        ...(modelNames.length
          ? {
              models: modelNames.map((name) => ({
                name,
                alias: name,
              })),
            }
          : {}),
      };
      try {
        await this.proxy.request(orgId, path, {
          method: "PUT",
          body: [...existing, group],
        });
        await this.ctx.db.run(
          "UPDATE inference_api_accounts SET state=? WHERE id=? AND org_id=?",
          ["active", id, orgId],
        );
      } catch (error) {
        await this.ctx.db.run(
          "UPDATE inference_api_accounts SET state=? WHERE id=? AND org_id=?",
          ["needs_attention", id, orgId],
        );
        throw error;
      }
      await this.ctx.audit(user, orgId, "inference.api_key.added", id, {
        provider: input.provider,
      });
      return {
        id,
        provider: input.provider,
        label,
        type: "api_key",
        status: "active",
      };
    });
  }
  private async groupList(
    orgId: string,
    family: string,
  ): Promise<Record<string, unknown>[]> {
    // Read the parent object because an absent family returns 404 in v8.
    const config = object(
      await this.proxy.request(orgId, "/v8/management/config"),
    );
    const groups = object(config["api-keys"])[family];
    return Array.isArray(groups) ? groups.map(object) : [];
  }
  async updateAccount(
    user: User,
    orgId: string,
    accountId: string,
    input: {
      enabled?: boolean;
      priority?: number;
      label?: string;
    },
  ) {
    await this.ctx.requireOrgAdmin(user, orgId);
    if (
      input.priority !== undefined &&
      (!Number.isInteger(input.priority) || Math.abs(input.priority) > 1000)
    )
      throw new InferenceError(
        400,
        "invalid_priority",
        "Priority must be an integer between -1000 and 1000.",
      );
    return this.locked(orgId, async () => {
      const api = await this.ctx.db.get<ApiAccount>(
        "SELECT * FROM inference_api_accounts WHERE id=? AND org_id=?",
        [accountId, orgId],
      );
      if (api) {
        const groups = await this.groupList(orgId, api.group_family);
        const entry = groups.find((group) => group.name === `wme-${api.id}`);
        if (!entry)
          throw new InferenceError(
            409,
            "account_needs_attention",
            "This account is missing from the inference service. Remove it and reconnect.",
          );
        if (input.priority !== undefined) entry.priority = input.priority;
        if (input.enabled !== undefined) {
          if (api.group_family === "openai-compatibility")
            entry.disabled = !input.enabled;
          else entry["excluded-models"] = input.enabled ? [] : ["*"];
        }
        await this.proxy.request(
          orgId,
          `/v8/management/config/api-keys/${api.group_family}`,
          {
            method: "PUT",
            body: groups,
          },
        );
        await this.ctx.db.run(
          "UPDATE inference_api_accounts SET label=?,state=? WHERE id=? AND org_id=?",
          [
            input.label === undefined ? api.label : validName(input.label),
            input.enabled === undefined
              ? api.state
              : input.enabled
                ? "active"
                : "disabled",
            api.id,
            orgId,
          ],
        );
      } else {
        const entry = (await this.rawAccounts(orgId)).find(
          (item) => this.subscriptionId(orgId, item) === accountId,
        );
        if (!entry || entry.runtime_only === true)
          throw new InferenceError(
            404,
            "account_not_found",
            "Account not found.",
          );
        const lookup = {
          name: entry.name,
          auth_index: entry.auth_index,
        };
        if (input.enabled !== undefined)
          await this.proxy.request(orgId, "/v8/management/credentials/status", {
            method: "PATCH",
            body: {
              ...lookup,
              disabled: !input.enabled,
            },
          });
        if (input.priority !== undefined)
          await this.proxy.request(orgId, "/v8/management/credentials/fields", {
            method: "PATCH",
            body: {
              ...lookup,
              priority: input.priority,
            },
          });
      }
      await this.ctx.audit(user, orgId, "inference.account.updated", accountId);
      return {
        ok: true,
      };
    });
  }
  async removeAccount(user: User, orgId: string, accountId: string) {
    await this.ctx.requireOrgAdmin(user, orgId);
    return this.locked(orgId, async () => {
      const api = await this.ctx.db.get<ApiAccount>(
        "SELECT * FROM inference_api_accounts WHERE id=? AND org_id=?",
        [accountId, orgId],
      );
      if (api) {
        const groups = await this.groupList(orgId, api.group_family);
        await this.proxy.request(
          orgId,
          `/v8/management/config/api-keys/${api.group_family}`,
          {
            method: "PUT",
            body: groups.filter((group) => group.name !== `wme-${api.id}`),
          },
        );
        await this.ctx.db.run(
          "DELETE FROM inference_api_accounts WHERE id=? AND org_id=?",
          [api.id, orgId],
        );
      } else {
        const entry = (await this.rawAccounts(orgId)).find(
          (item) => this.subscriptionId(orgId, item) === accountId,
        );
        if (!entry || entry.runtime_only === true)
          throw new InferenceError(
            404,
            "account_not_found",
            "Account not found.",
          );
        await this.proxy.request(
          orgId,
          `/v8/management/credentials?name=${encodeURIComponent(String(entry.name))}`,
          {
            method: "DELETE",
          },
        );
      }
      await this.ctx.audit(user, orgId, "inference.account.removed", accountId);
      return {
        ok: true,
      };
    });
  }
  async refreshAccount(user: User, orgId: string, accountId: string) {
    await this.ctx.requireOrgAdmin(user, orgId);
    const entry = (await this.rawAccounts(orgId)).find(
      (item) => this.subscriptionId(orgId, item) === accountId,
    );
    if (!entry || entry.runtime_only === true)
      throw new InferenceError(
        404,
        "account_not_found",
        "Subscription account not found.",
      );
    await this.proxy.request(orgId, "/v8/management/credentials/refresh", {
      method: "POST",
      body: {
        name: entry.name,
        auth_index: entry.auth_index,
      },
    });
    await this.ctx.audit(user, orgId, "inference.account.refreshed", accountId);
    return {
      ok: true,
    };
  }
  async startOAuth(
    user: User,
    orgId: string,
    provider: SubscriptionProvider,
    acceptedRisk: boolean,
  ) {
    await this.ctx.requireOrgAdmin(user, orgId);
    if (!(provider in providerNames))
      throw new InferenceError(
        400,
        "invalid_provider",
        "Choose a supported subscription provider.",
      );
    if (provider === "anthropic" && !acceptedRisk)
      throw new InferenceError(
        400,
        "claude_notice_required",
        CLAUDE_SUBSCRIPTION_NOTICE,
      );
    await this.ensure(orgId);
    const data = object(
      await this.proxy.request(
        orgId,
        `/v8/management/oauth/auth-url?provider=${providerNames[provider]}&is_webui=true`,
      ),
    );
    const state = text(data.state, 512);
    const authUrl = text(data.url, 8192);
    if (!state || !authUrl)
      throw new InferenceError(
        502,
        "invalid_oauth_response",
        "The inference service did not return a sign-in session.",
      );
    let parsed: URL;
    try {
      parsed = new URL(authUrl);
    } catch {
      throw new InferenceError(
        502,
        "invalid_oauth_response",
        "The inference service returned an invalid sign-in URL.",
      );
    }
    const hosts =
      provider === "openai"
        ? ["auth.openai.com", "chatgpt.com"]
        : provider === "anthropic"
          ? ["claude.ai", "platform.claude.com", "console.anthropic.com"]
          : ["accounts.x.ai", "grok.com", "auth.x.ai"];
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !hosts.includes(parsed.hostname)
    )
      throw new InferenceError(
        502,
        "invalid_oauth_response",
        "The inference service returned an unapproved sign-in URL.",
      );
    const id = randomUUID();
    const expiresAt = new Date(
      Date.now() + Math.min(count(data.expires_in) || 900, 1800) * 1000,
    ).toISOString();
    await this.ctx.db.run(
      "INSERT INTO inference_oauth_sessions (id,org_id,user_id,provider,state,expires_at,status) VALUES (?,?,?,?,?,?,?)",
      [id, orgId, user.id, provider, state, expiresAt, "pending"],
    );
    await this.ctx.audit(user, orgId, "inference.subscription.started", id, {
      provider,
      ...(provider === "anthropic"
        ? {
            riskAcknowledged: true,
          }
        : {}),
    });
    return {
      id,
      url: authUrl,
      userCode: text(data.user_code, 32),
      expiresAt,
    };
  }
  private async oauthSession(
    user: User,
    orgId: string,
    id: string,
  ): Promise<OAuthRow> {
    await this.ctx.requireOrgAdmin(user, orgId);
    const row = await this.ctx.db.get<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE id=? AND org_id=? AND user_id=?",
      [id, orgId, user.id],
    );
    if (!row || row.expires_at < new Date().toISOString())
      throw new InferenceError(
        404,
        "oauth_session_not_found",
        "This sign-in session has expired or is unavailable.",
      );
    return row;
  }
  async oauthStatus(user: User, orgId: string, id: string) {
    const row = await this.oauthSession(user, orgId, id);
    if (row.status !== "pending")
      return {
        status: row.status,
      };
    const data = object(
      await this.proxy.request(
        orgId,
        `/v8/management/oauth/status?state=${encodeURIComponent(row.state)}`,
      ),
    );
    const status =
      data.status === "ok"
        ? "complete"
        : data.status === "error"
          ? "error"
          : "pending";
    if (status !== "pending")
      await this.ctx.db.run(
        "UPDATE inference_oauth_sessions SET status=? WHERE id=?",
        [status, row.id],
      );
    return {
      status,
      ...(status === "error"
        ? {
            message: "Sign-in did not complete. Start a new sign-in session.",
          }
        : {}),
    };
  }
  async oauthCallback(
    user: User,
    orgId: string,
    id: string,
    redirectUrl: string,
  ) {
    const row = await this.oauthSession(user, orgId, id);
    if (row.status !== "pending")
      throw new InferenceError(
        409,
        "oauth_session_closed",
        "This sign-in session is already closed.",
      );
    if (typeof redirectUrl !== "string" || redirectUrl.length > 16384)
      throw new InferenceError(
        400,
        "invalid_callback",
        "Enter the callback URL from your sign-in flow.",
      );
    let parsed: URL;
    try {
      parsed = new URL(redirectUrl);
    } catch {
      throw new InferenceError(
        400,
        "invalid_callback",
        "Enter a valid callback URL.",
      );
    }
    // Parse only; never navigate or fetch the supplied URL.
    if (
      parsed.searchParams.get("state") !== row.state ||
      !parsed.searchParams.get("code")
    )
      throw new InferenceError(
        400,
        "oauth_state_mismatch",
        "The callback does not belong to this sign-in session.",
      );
    await this.proxy.request(orgId, "/v8/management/oauth/callback", {
      method: "POST",
      body: {
        provider: providerNames[row.provider],
        state: row.state,
        code: parsed.searchParams.get("code"),
      },
    });
    return {
      status: "pending",
    }; // Exchange and persistence still need status confirmation.
  }

  async cancelOAuth(user: User, orgId: string, id: string) {
    const row = await this.oauthSession(user, orgId, id);
    if (row.status === "pending")
      await this.proxy.request(
        orgId,
        `/v8/management/oauth/session?state=${encodeURIComponent(row.state)}`,
        {
          method: "DELETE",
        },
      );
    await this.ctx.db.run(
      "UPDATE inference_oauth_sessions SET status=? WHERE id=?",
      ["cancelled", row.id],
    );
    return {
      status: "cancelled",
    };
  }
  async models(orgId: string): Promise<InferenceModel[]> {
    if (!(await this.options.registry.resolve(orgId))) return [];
    const data = object(
      await this.proxy.request(orgId, "/v1/models", {
        client: true,
      }),
    );
    if (!Array.isArray(data.data)) return [];
    const accounts = await this.ctx.db.all<Pick<ApiAccount, "id" | "provider">>(
      "SELECT id,provider FROM inference_api_accounts WHERE org_id=?",
      [orgId],
    );
    const configuredProviders = new Map(
      accounts.map((account) => [`wme-${account.id}`, account.provider]),
    );
    return data.data
      .map(object)
      .filter((item) => typeof item.id === "string" && item.id.length <= 240)
      .map((item) => ({
        id: String(item.id),
        name: text(item.name) ?? String(item.id),
        provider:
          configuredProviders.get(String(item.owned_by ?? item.provider)) ??
          familyProvider(item.owned_by ?? item.provider),
      }));
  }
  async defaultHarness(
    orgId: string,
    model: string,
  ): Promise<"codex" | "claude" | "grok" | "pi"> {
    const selected = (await this.models(orgId)).find(
      (item) => item.id === model,
    );
    if (!selected)
      throw new InferenceError(
        400,
        "model_unavailable",
        "This model is not available in the organization inference pool.",
      );
    return selected.provider === "openai"
      ? "codex"
      : selected.provider === "anthropic"
        ? "claude"
        : selected.provider === "xai"
          ? "grok"
          : "pi";
  }
  async validateSelection(
    orgId: string,
    model: string,
    harness: string,
    connectionId?: string,
  ) {
    if (!["codex", "claude", "grok", "pi"].includes(harness))
      throw new InferenceError(
        400,
        "invalid_harness",
        "Choose a supported agent.",
      );
    if (connectionId)
      throw new InferenceError(
        400,
        "connection_selection_unavailable",
        "Select a model from the organization pool; individual connection targeting is not enabled.",
      );
    const selected = (await this.models(orgId)).find(
      (item) => item.id === model,
    );
    if (!selected)
      throw new InferenceError(
        400,
        "model_unavailable",
        "This model is not available in the organization inference pool.",
      );
    const expected: Record<string, string> = {
      codex: "openai",
      claude: "anthropic",
      grok: "xai",
    };
    if (harness !== "pi" && selected.provider !== expected[harness])
      throw new InferenceError(
        400,
        "harness_model_mismatch",
        "Choose the native agent for this model, or choose Pi.",
      );
  }
  async usage(orgId: string) {
    if (!(await this.options.registry.resolve(orgId)))
      return {
        items: [],
      };
    const [apiUsage, subscriptions] = await Promise.all([
      this.proxy.request(orgId, "/v8/management/observability/usage/api-keys"),
      this.rawAccounts(orgId),
    ]);
    const totals = new Map<
      string,
      {
        provider: string;
        successes: number;
        failures: number;
      }
    >();
    function add(provider: string, success: unknown, failed: unknown) {
      const total = totals.get(provider) ?? {
        provider,
        successes: 0,
        failures: 0,
      };
      total.successes += count(success);
      total.failures += count(failed);
      totals.set(provider, total);
    }
    // Composite map keys contain actual API keys. Never expose or persist them.
    for (const [provider, entries] of Object.entries(object(apiUsage)))
      for (const entry of Object.values(object(entries))) {
        const value = object(entry);
        add(familyProvider(provider), value.success, value.failed);
      }
    for (const entry of subscriptions.filter(
      (item) => item.runtime_only !== true,
    ))
      add(familyProvider(entry.provider), entry.success, entry.failed);
    return {
      items: [...totals.values()],
      observedAt: new Date().toISOString(),
    };
  }
  async issueGateway(scope: RunScope): Promise<{
    baseUrl: string;
    token: string;
  }> {
    if (!(await this.options.canUseRun(scope)))
      throw new InferenceError(
        403,
        "run_access_denied",
        "This run no longer has access to inference.",
      );
    await this.proxy.endpoint(scope.orgId);
    const token = `wme_run_${randomBytes(32).toString("base64url")}`;
    await this.ctx.db.run(
      "INSERT INTO inference_gateway_tokens (token_hash,org_id,project_id,user_id,run_id,conversation_id,model,harness,expires_at,revoked) VALUES (?,?,?,?,?,?,?,?,?,0)",
      [
        hash(token),
        scope.orgId,
        scope.projectId,
        scope.userId,
        scope.runId,
        scope.conversationId ?? null,
        scope.model,
        scope.harness,
        new Date(Date.now() + 24 * 3600_000).toISOString(),
      ],
    );
    const origin = (
      this.options.runtimeApiOrigin ?? this.ctx.config.publicOrigin
    ).replace(/\/$/, "");
    return {
      baseUrl: `${origin}/enterprise/api/runtime/inference/${encodeURIComponent(scope.projectId)}`,
      token,
    };
  }
  async authorizeGateway(projectId: string, token: string): Promise<RunScope> {
    if (!token.startsWith("wme_run_") || token.length > 100)
      throw new InferenceError(
        401,
        "invalid_gateway_token",
        "A valid run credential is required.",
      );
    const row = await this.ctx.db.get<GatewayRow>(
      "SELECT * FROM inference_gateway_tokens WHERE token_hash=? AND project_id=? AND revoked=0 AND expires_at>?",
      [hash(token), projectId, new Date().toISOString()],
    );
    const scope = row && {
      orgId: row.org_id,
      projectId: row.project_id,
      userId: row.user_id,
      runId: row.run_id,
      model: row.model,
      harness: row.harness,
      conversationId: row.conversation_id ?? undefined,
    };
    if (!scope || !(await this.options.canUseRun(scope)))
      throw new InferenceError(
        403,
        "run_access_denied",
        "This run no longer has access to inference.",
      );
    return scope;
  }
  async revokeGateway(runId: string) {
    await this.ctx.db.run(
      "UPDATE inference_gateway_tokens SET revoked=1 WHERE run_id=?",
      [runId],
    );
  }
}
function validDate(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}
function validDisplayEmail(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? value
    : undefined;
}
