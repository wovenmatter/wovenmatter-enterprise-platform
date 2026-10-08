import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { setTimeout as wait } from "node:timers/promises";
import { discoverProviderModels } from "./discovery.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError, mapUser, type AppContext, type User } from "../context.js";
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
  assetId?: string;
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
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
};
export type PiProvider =
  | "openai"
  | "anthropic"
  | "xai"
  | "openrouter"
  | "custom";
export type PiGatewayApi =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-compatible";
export type ResolvedPiModel = {
  model: string;
  provider: PiProvider;
  api: PiGatewayApi;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsNativeCompaction: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  routeIdentity: string;
  accountAffinity: "proxy-session-affinity";
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
  flow: string | null;
  url: string | null;
  user_code: string | null;
  interval: number | null;
  auth_session_id: string | null;
  protocol: number;
}
interface GatewayRow {
  org_id: string;
  project_id: string | null;
  asset_id: string | null;
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
function optionalCount(value: unknown): number | undefined {
  const numeric = count(value);
  return numeric > 0 ? numeric : undefined;
}
function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function knownPiCapabilities(provider: PiProvider, id: string) {
  if (provider === "custom") return undefined;
  const model = getBuiltinModels(provider).find((model) => model.id === id);
  return model
    ? {
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsImages: model.input.includes("image"),
        supportsReasoning: model.reasoning,
      }
    : undefined;
}
/** A single API process owns proxy configuration writes; worker jobs call this owner. */
export class InferenceService {
  readonly proxy: ProxyClient;
  private readonly oauthWorkers = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private closing = false;
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
      "remote-signin-v1",
      `
      ALTER TABLE inference_oauth_sessions ADD COLUMN flow TEXT;
      ALTER TABLE inference_oauth_sessions ADD COLUMN url TEXT;
      ALTER TABLE inference_oauth_sessions ADD COLUMN user_code TEXT;
      ALTER TABLE inference_oauth_sessions ADD COLUMN interval INTEGER;
      ALTER TABLE inference_oauth_sessions ADD COLUMN auth_session_id TEXT;
      ALTER TABLE inference_oauth_sessions ADD COLUMN protocol INTEGER NOT NULL DEFAULT 0;
      UPDATE inference_oauth_sessions SET status='interrupted' WHERE status='pending';
    `,
    );
    await this.ctx.db.migrate(
      "asset-inference-v1",
      `
CREATE TABLE inference_gateway_next(token_hash TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),project_id TEXT REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),run_id TEXT NOT NULL,conversation_id TEXT,model TEXT NOT NULL,harness TEXT NOT NULL,expires_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,asset_id TEXT,CHECK(project_id IS NOT NULL OR asset_id IS NOT NULL));
INSERT INTO inference_gateway_next SELECT *,NULL FROM inference_gateway_tokens;
DROP TABLE inference_gateway_tokens;
ALTER TABLE inference_gateway_next RENAME TO inference_gateway_tokens;
CREATE INDEX inference_gateway_tokens_run ON inference_gateway_tokens(run_id);
`,
    );
    const pending = await this.ctx.db.all<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE protocol=1 AND status IN ('starting','pending','cancelling')",
    );
    for (const row of pending) this.watchOAuth(row.id, row.org_id);
    await this.ctx.db.migrate(
      "project-egress-v1",
      "CREATE TABLE project_egress_capabilities(project_id TEXT PRIMARY KEY REFERENCES projects(id),org_id TEXT NOT NULL REFERENCES organizations(id),host_id TEXT NOT NULL,token_hash TEXT NOT NULL);",
    );
  }
  async closeOAuth() {
    this.closing = true;
    for (const worker of this.oauthWorkers.values()) worker.controller.abort();
    await Promise.allSettled(
      [...this.oauthWorkers.values()].map((w) => w.task),
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
    const attempts = await this.ctx.db.all<{ id: string }>(
      "SELECT id FROM inference_oauth_sessions WHERE org_id=? AND protocol=1 AND status<>'complete'",
      [orgId],
    );
    const unconfirmed = new Set(
      attempts.map((row) => `enterprise-${row.id}.json`),
    );
    return Array.isArray(data.files)
      ? data.files
          .map(object)
          .filter((row) => !unconfirmed.has(String(row.name)))
      : [];
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
  private oauthDto(row: OAuthRow) {
    const messages: Record<string, string> = {
      starting: "Preparing sign-in…",
      pending: "Waiting for provider approval.",
      complete: "Connection saved.",
      expired: "This sign-in expired. Start a new sign-in.",
      denied: "The provider denied sign-in. You can try again.",
      interrupted:
        "Sign-in was interrupted. Check Connections, then start a new sign-in if needed.",
      error:
        "The provider could not complete sign-in. Check that subscription sign-in is available for your account, then try again or use an API key.",
      cancelling: "Cancelling sign-in…",
      cancelled: "Sign-in cancelled.",
    };
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      message: messages[row.status],
      expiresAt: row.expires_at,
      flow: row.flow,
      interval: row.interval,
      ...(["starting", "pending"].includes(row.status)
        ? { url: row.url, userCode: row.user_code }
        : {}),
    };
  }
  private async oauthAuthority(row: OAuthRow) {
    const record = await this.ctx.db.get(
      "SELECT * FROM users WHERE id=? AND enabled=1",
      [row.user_id],
    );
    if (!record)
      throw new InferenceError(
        403,
        "signin_revoked",
        "Sign-in access was removed.",
      );
    const user = mapUser(record);
    await this.ctx.requireOrgAdmin(user, row.org_id);
    if (
      row.auth_session_id &&
      !(await this.ctx.isSessionActive(row.auth_session_id, row.user_id))
    )
      throw new InferenceError(
        403,
        "signin_revoked",
        "The initiating sign-in session ended.",
      );
    return user;
  }
  private async saveOAuthStatus(
    id: string,
    status: string,
    finishCancellation = false,
  ) {
    await this.ctx.db.run(
      "UPDATE inference_oauth_sessions SET status=?,url=CASE WHEN ? IN ('starting','pending') THEN url ELSE NULL END,user_code=CASE WHEN ? IN ('starting','pending') THEN user_code ELSE NULL END WHERE id=? AND (status<>'cancelling' OR ?=1)",
      [
        status,
        status,
        status,
        id,
        finishCancellation ||
        status === "cancelling" ||
        status === "cancelled" ||
        status === "expired" ||
        status === "interrupted"
          ? 1
          : 0,
      ],
    );
  }
  private remotePath(row: OAuthRow) {
    return `/v8/management/oauth/remote/${encodeURIComponent(row.state)}`;
  }
  private async readRemote(row: OAuthRow, data: Record<string, unknown>) {
    const allowed = [
      "starting",
      "pending",
      "ready",
      "complete",
      "denied",
      "expired",
      "error",
      "interrupted",
      "cancelled",
    ];
    if (!allowed.includes(String(data.status)))
      throw new InferenceError(
        502,
        "invalid_oauth_response",
        "The inference service returned an invalid sign-in status.",
      );
    if (data.status !== "pending" && data.status !== "ready")
      return String(data.status);
    const flow = data.flow,
      authUrl = text(data.url, 8192),
      deadline =
        typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    const hosts =
      row.provider === "openai"
        ? ["auth.openai.com", "chatgpt.com"]
        : row.provider === "anthropic"
          ? ["claude.ai", "platform.claude.com", "console.anthropic.com"]
          : ["accounts.x.ai", "grok.com", "auth.x.ai"];
    let parsed: URL;
    try {
      parsed = new URL(authUrl!);
    } catch {
      throw new InferenceError(
        502,
        "invalid_oauth_response",
        "The inference service returned an invalid sign-in URL.",
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !hosts.includes(parsed.hostname) ||
      flow !== (row.provider === "anthropic" ? "manual_code" : "device") ||
      !Number.isFinite(deadline) ||
      deadline > Date.parse(row.expires_at) + 30_000 ||
      (flow === "device" &&
        (!text(data.user_code, 64) ||
          !Number.isInteger(data.interval) ||
          Number(data.interval) < 1))
    )
      throw new InferenceError(
        502,
        "invalid_oauth_response",
        "The inference service returned unsupported sign-in instructions.",
      );
    await this.ctx.db.run(
      "UPDATE inference_oauth_sessions SET flow=?,url=?,user_code=?,interval=?,expires_at=? WHERE id=?",
      [
        String(flow),
        authUrl!,
        text(data.user_code, 64) ?? null,
        Number(data.interval) || 0,
        new Date(Math.min(deadline, Date.parse(row.expires_at))).toISOString(),
        row.id,
      ],
    );
    return String(data.status);
  }
  async startOAuth(
    user: User,
    orgId: string,
    provider: SubscriptionProvider,
    acceptedRisk: boolean,
    authSessionId?: string,
  ) {
    return this.locked(orgId, async () => {
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
      const existing = await this.ctx.db.get<OAuthRow>(
        "SELECT * FROM inference_oauth_sessions WHERE org_id=? AND user_id=? AND provider=? AND status IN ('starting','pending','cancelling') ORDER BY expires_at DESC LIMIT 1",
        [orgId, user.id, provider],
      );
      if (existing) {
        this.watchOAuth(existing.id, orgId);
        return this.oauthDto(existing);
      }
      await this.ensure(orgId);
      const id = randomUUID(),
        expiresAt = new Date(
          Date.now() +
            (provider === "anthropic"
              ? 300
              : provider === "openai"
                ? 900
                : 1800) *
              1000,
        ).toISOString();
      await this.ctx.db.run(
        "INSERT INTO inference_oauth_sessions(id,org_id,user_id,provider,state,expires_at,status,auth_session_id,protocol) VALUES(?,?,?,?,?,?,'starting',?,1)",
        [id, orgId, user.id, provider, id, expiresAt, authSessionId ?? null],
      );
      let row = (await this.ctx.db.get<OAuthRow>(
        "SELECT * FROM inference_oauth_sessions WHERE id=?",
        [id],
      ))!;
      try {
        await this.oauthAuthority(row);
        const data = object(
          await this.proxy.request(orgId, "/v8/management/oauth/remote", {
            method: "POST",
            body: { id, provider: providerNames[provider] },
          }),
        );
        const state = await this.readRemote(row, data);
        await this.oauthAuthority(row);
        await this.saveOAuthStatus(id, state === "ready" ? "pending" : state);
      } catch (error) {
        // A lost initiation response is uncertain: reconnect by ID, never request another grant.
        if (
          error instanceof AppError &&
          ([401, 403, 404].includes(error.statusCode) ||
            error.code === "invalid_oauth_response")
        ) {
          await this.saveOAuthStatus(id, "cancelling");
          try {
            await this.proxy.request(orgId, this.remotePath(row), {
              method: "DELETE",
            });
            await this.saveOAuthStatus(id, "error", true);
          } catch {
            /* Bounded worker retries cancellation. */
          }
        }
      }
      row = (await this.ctx.db.get<OAuthRow>(
        "SELECT * FROM inference_oauth_sessions WHERE id=?",
        [id],
      ))!;
      this.watchOAuth(id, orgId);
      await this.ctx.audit(user, orgId, "inference.subscription.started", id, {
        provider,
        ...(provider === "anthropic" ? { riskAcknowledged: true } : {}),
      });
      return this.oauthDto(row);
    });
  }
  private watchOAuth(id: string, orgId: string) {
    if (this.closing || this.oauthWorkers.has(id)) return;
    const controller = new AbortController();
    const task = (async () => {
      let retryDelay = 1500;
      while (!controller.signal.aborted) {
        try {
          const pending = await this.locked(orgId, () => this.syncOAuth(id));
          if (!pending) return;
          retryDelay = 1500;
        } catch {
          // Only cleanup may outlive the grant deadline. Persist its fence until confirmed.
          const row = await this.ctx.db.get<OAuthRow>(
            "SELECT * FROM inference_oauth_sessions WHERE id=?",
            [id],
          );
          if (!row) return;
          if (Date.now() >= Date.parse(row.expires_at))
            await this.saveOAuthStatus(id, "cancelling");
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
        try {
          await wait(retryDelay, undefined, { signal: controller.signal });
        } catch {
          return;
        }
      }
    })()
      .finally(async () => {
        this.oauthWorkers.delete(id);
        // A cancel can arrive as a terminal observer exits. Do not lose its retry owner.
        if (!this.closing) {
          const row = await this.ctx.db.get<OAuthRow>(
            "SELECT * FROM inference_oauth_sessions WHERE id=?",
            [id],
          );
          if (row?.status === "cancelling") this.watchOAuth(id, orgId);
        }
      })
      .catch(() => {
        /* Database shutdown cannot erase the durable retry receipt. */
      });
    this.oauthWorkers.set(id, { controller, task });
  }
  private async syncOAuth(id: string) {
    const row = await this.ctx.db.get<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE id=?",
      [id],
    );
    if (!row || !["starting", "pending", "cancelling"].includes(row.status))
      return false;
    let permitted = true;
    try {
      await this.oauthAuthority(row);
    } catch {
      permitted = false;
    }
    const expired = Date.parse(row.expires_at) <= Date.now();
    if (row.status === "cancelling" || !permitted || expired) {
      await this.saveOAuthStatus(id, "cancelling");
      await this.proxy.request(row.org_id, this.remotePath(row), {
        method: "DELETE",
      });
      await this.saveOAuthStatus(id, expired ? "expired" : "cancelled");
      return false;
    }
    const data = object(
      await this.proxy.request(row.org_id, this.remotePath(row)),
    );
    let status: string;
    try {
      status = await this.readRemote(row, data);
    } catch {
      await this.saveOAuthStatus(id, "cancelling");
      await this.proxy.request(row.org_id, this.remotePath(row), {
        method: "DELETE",
      });
      await this.saveOAuthStatus(id, "error", true);
      return false;
    }
    if (status === "ready") {
      await this.oauthAuthority(row);
      const committed = object(
        await this.proxy.request(row.org_id, `${this.remotePath(row)}/commit`, {
          method: "POST",
          body: {},
        }),
      );
      status = String(committed.status);
      if (!["complete", "error", "expired", "interrupted"].includes(status))
        throw new InferenceError(
          502,
          "invalid_oauth_response",
          "Could not confirm connection persistence.",
        );
    }
    if (status === "interrupted") {
      // An inference crash during saving is uncertain. Retire only this attempt before retry.
      await this.saveOAuthStatus(id, "cancelling");
      await this.proxy.request(row.org_id, this.remotePath(row), {
        method: "DELETE",
      });
      await this.saveOAuthStatus(id, "interrupted", true);
      return false;
    }
    const current = await this.ctx.db.get<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE id=?",
      [id],
    );
    if (current?.status === "cancelling") {
      await this.proxy.request(row.org_id, this.remotePath(row), {
        method: "DELETE",
      });
      await this.saveOAuthStatus(id, "cancelled");
      return false;
    }
    if (status === "complete") {
      try {
        await this.oauthAuthority(row);
      } catch {
        await this.saveOAuthStatus(id, "cancelling");
        await this.proxy.request(row.org_id, this.remotePath(row), {
          method: "DELETE",
        });
        await this.saveOAuthStatus(id, "cancelled");
        return false;
      }
    }
    await this.saveOAuthStatus(id, status);
    return ["starting", "pending"].includes(status);
  }
  async recheckOAuthAccess() {
    const rows = await this.ctx.db.all<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE protocol=1 AND status IN ('starting','pending','cancelling')",
    );
    const results = await Promise.allSettled(
      rows.map(async (row) => {
        let revoked = false;
        try {
          await this.oauthAuthority(row);
        } catch {
          revoked = true;
        }
        if (revoked) await this.saveOAuthStatus(row.id, "cancelling");
        this.watchOAuth(row.id, row.org_id);
        if (revoked)
          await this.locked(row.org_id, async () => {
            await this.proxy.request(row.org_id, this.remotePath(row), {
              method: "DELETE",
            });
            await this.saveOAuthStatus(row.id, "cancelled");
          });
      }),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  private async oauthSession(user: User, orgId: string, id: string) {
    await this.ctx.requireOrgAdmin(user, orgId);
    const row = await this.ctx.db.get<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE id=? AND org_id=? AND user_id=?",
      [id, orgId, user.id],
    );
    if (!row)
      throw new InferenceError(
        404,
        "oauth_session_not_found",
        "Sign-in session unavailable.",
      );
    return row;
  }
  async oauthSessions(user: User, orgId: string) {
    await this.ctx.requireOrgAdmin(user, orgId);
    const rows = await this.ctx.db.all<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE org_id=? AND user_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 12",
      [orgId, user.id, new Date(Date.now() - 86400000).toISOString()],
    );
    for (const row of rows)
      if (["starting", "pending", "cancelling"].includes(row.status))
        this.watchOAuth(row.id, orgId);
    return { items: rows.map((row) => this.oauthDto(row)) };
  }
  async oauthStatus(user: User, orgId: string, id: string) {
    const row = await this.oauthSession(user, orgId, id);
    if (["starting", "pending", "cancelling"].includes(row.status))
      this.watchOAuth(id, orgId);
    return this.oauthDto(row);
  }
  async oauthCode(user: User, orgId: string, id: string, code: string) {
    return this.locked(orgId, async () => {
      const row = await this.oauthSession(user, orgId, id);
      await this.oauthAuthority(row);
      if (
        row.status !== "pending" ||
        row.flow !== "manual_code" ||
        Date.parse(row.expires_at) <= Date.now()
      )
        throw new InferenceError(
          409,
          "oauth_session_closed",
          "This sign-in is closed or does not accept a code.",
        );
      if (typeof code !== "string" || !code.trim() || code.length > 4096)
        throw new InferenceError(
          400,
          "invalid_code",
          "Enter the authorization code shown by the provider.",
        );
      await this.proxy.request(orgId, `${this.remotePath(row)}/code`, {
        method: "POST",
        body: { code: code.trim() },
      });
      return { status: "pending" };
    });
  }
  async cancelOAuth(user: User, orgId: string, id: string) {
    const admitted = await this.oauthSession(user, orgId, id);
    if (!["starting", "pending", "cancelling"].includes(admitted.status))
      return this.oauthDto(admitted);
    // Persist intent before waiting behind an in-flight token save. Completion cannot erase it.
    await this.saveOAuthStatus(id, "cancelling");
    this.watchOAuth(id, orgId);
    return this.locked(orgId, async () => {
      const row = await this.oauthSession(user, orgId, id);
      if (row.status === "cancelled") return this.oauthDto(row);
      await this.proxy.request(orgId, this.remotePath(row), {
        method: "DELETE",
      });
      await this.saveOAuthStatus(id, "cancelled");
      return { status: "cancelled" };
    });
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
        contextWindow: optionalCount(
          item.context_window ??
            item.contextWindow ??
            item.context_length ??
            item.contextLength,
        ),
        maxOutputTokens: optionalCount(
          item.max_output_tokens ??
            item.maxOutputTokens ??
            item.max_tokens ??
            item.maxTokens,
        ),
        supportsImages: optionalBoolean(
          item.supports_images ??
            item.supportsImages ??
            object(item.capabilities).images ??
            object(item.capabilities).vision,
        ),
        supportsReasoning: optionalBoolean(
          item.supports_reasoning ??
            item.supportsReasoning ??
            object(item.capabilities).reasoning,
        ),
      }));
  }
  async resolvePiModel(orgId: string, model: string): Promise<ResolvedPiModel> {
    const selected = (await this.models(orgId)).find(
      (item) => item.id === model,
    );
    if (!selected)
      throw new InferenceError(
        400,
        "model_unavailable",
        "This model is not available in the organization inference pool.",
      );
    const provider = (
      ["openai", "anthropic", "xai", "openrouter"].includes(selected.provider)
        ? selected.provider
        : "custom"
    ) as PiProvider;
    const fallback = knownPiCapabilities(provider, selected.id);
    const api: PiGatewayApi =
      provider === "anthropic"
        ? "anthropic-messages"
        : provider === "openai" || provider === "xai"
          ? "openai-responses"
          : "openai-compatible";
    return {
      model: selected.id,
      provider,
      api,
      contextWindow: selected.contextWindow ?? fallback?.contextWindow,
      maxOutputTokens: selected.maxOutputTokens ?? fallback?.maxOutputTokens,
      supportsNativeCompaction:
        provider === "openai" || provider === "anthropic" || provider === "xai",
      supportsImages: selected.supportsImages ?? fallback?.supportsImages,
      supportsReasoning:
        selected.supportsReasoning ?? fallback?.supportsReasoning,
      routeIdentity: `${provider}:${api}:${selected.id}`,
      accountAffinity: "proxy-session-affinity",
    };
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
    return "pi";
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
  private async requireSettledCleanup(orgId: string) {
    const row = await this.ctx.db.get<OAuthRow>(
      "SELECT * FROM inference_oauth_sessions WHERE org_id=? AND protocol=1 AND (status='cancelling' OR (status IN ('starting','pending') AND expires_at<=?)) LIMIT 1",
      [orgId, new Date().toISOString()],
    );
    if (row) {
      this.watchOAuth(row.id, orgId);
      throw new InferenceError(
        503,
        "signin_cleanup_pending",
        "A cancelled sign-in is awaiting confirmed cleanup. Inference will resume when cleanup finishes.",
      );
    }
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
    await this.requireSettledCleanup(scope.orgId);
    await this.proxy.endpoint(scope.orgId);
    const token = `wme_run_${randomBytes(32).toString("base64url")}`;
    await this.ctx.db.run(
      "INSERT INTO inference_gateway_tokens (token_hash,org_id,project_id,user_id,run_id,conversation_id,model,harness,expires_at,revoked,asset_id) VALUES (?,?,?,?,?,?,?,?,?,0,?)",
      [
        hash(token),
        scope.orgId,
        scope.assetId && scope.projectId === "asset-" + scope.assetId
          ? null
          : scope.projectId,
        scope.userId,
        scope.runId,
        scope.conversationId ?? null,
        scope.model,
        scope.harness,
        new Date(Date.now() + 24 * 3600_000).toISOString(),
        scope.assetId ?? null,
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
      "SELECT * FROM inference_gateway_tokens WHERE token_hash=? AND COALESCE(project_id,'asset-'||asset_id)=? AND revoked=0 AND expires_at>?",
      [hash(token), projectId, new Date().toISOString()],
    );
    const scope = row && {
      orgId: row.org_id,
      projectId: row.project_id ?? "asset-" + row.asset_id,
      assetId: row.asset_id ?? undefined,
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
    await this.requireSettledCleanup(scope.orgId);
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
