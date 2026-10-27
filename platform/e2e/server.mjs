// Explicit synthetic acceptance harness. Never imported by the production entrypoint.
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../dist/apps/api/src/app.js";
import { ProxyClient } from "../dist/apps/api/src/inference/proxy-client.js";
import { newSession } from "../dist/apps/api/src/auth/session.js";
if (process.env.WME_E2E_FIXTURE !== "1")
  throw new Error("Synthetic acceptance requires WME_E2E_FIXTURE=1");
const port = Number(process.env.WME_E2E_PORT ?? 4155);
const origin = `http://localhost:${port}`;
const stateDir = await mkdtemp(
  join(process.env.WME_E2E_STATE_PARENT ?? tmpdir(), "wme-browser-"),
);
const output = resolve(
  process.env.WME_E2E_OUTPUT ?? `${tmpdir()}/wme-e2e-evidence`,
);
await mkdir(output, { recursive: true });
const native = process.env.WME_E2E_AGENT_IMAGE
  ? await (
      await import("./native-runtime.mjs")
    ).nativeFixture({
      stateDir,
      origin,
      output,
      image: process.env.WME_E2E_AGENT_IMAGE,
    })
  : undefined;
const webRoot = join(stateDir, "web");
await cp(resolve("platform/apps/web/dist"), webRoot, { recursive: true });
let syntheticBrowserImage;
const runtime = native?.runtime ?? {
  async sdkCatalog() {
    return {
      bundledGeneration: "fixture-sdk-one",
      defaultGeneration: "fixture-sdk-one",
      items: [
        {
          id: "fixture-sdk-one",
          label: "Bundled fixture",
          piVersion: "1.1.0",
          status: "approved",
          bundled: true,
          integrity: { algorithm: "sha256", manifest: "0".repeat(64) },
        },
        {
          id: "fixture-sdk-two",
          label: "Approved test fixture",
          piVersion: "1.1.0",
          status: "approved",
          integrity: { algorithm: "sha256", manifest: "1".repeat(64) },
        },
      ],
    };
  },
  // Explicit synthetic browser transport for rendered controls; actual Chromium
  // and namespace authority are covered by container-acceptance.mjs.
  browserTabs:new Map(),
  async browser(projectId,conversationId,input){
    let tabs=this.browserTabs.get(conversationId)??[];
    if(input.action==="tabs")return {structuredContent:{running:tabs.length>0,tabs}};
    if(input.action==="stop"){this.browserTabs.delete(conversationId);return {structuredContent:{stopped:true}};}
    if(input.attachOnly&&!tabs.length)throw new Error("No managed browser exists.");
    if(input.action==="open"){const id=randomUUID();tabs=[...tabs,{id,title:"Synthetic browser surface",url:input.url}];this.browserTabs.set(conversationId,tabs);return {structuredContent:{id}};}
    if(input.action==="close"){this.browserTabs.set(conversationId,tabs.filter(tab=>tab.id!==input.tabId));return {structuredContent:{closed:true}};}
    if(input.action==="navigate"){const tab=tabs.find(tab=>tab.id===input.tabId);if(tab)tab.url=input.url;}
    if(input.action==="snapshot")return {structuredContent:{snapshot:"Synthetic isolated page: no external browser traffic"}};
    if(input.action==="screenshot"){
      syntheticBrowserImage??=(async()=>{const{chromium}=await import("playwright-core");const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1280,height:800}});await page.setContent('<!doctype html><style>body{font:20px system-ui;background:#f3f7f4;color:#173d28;padding:70px}section{background:white;border:1px solid #b4cbbc;border-radius:20px;padding:48px}small{color:#58745e}button{background:#257448;color:white;padding:14px 24px;border:0;border-radius:8px;font:inherit}</style><section><small>DETERMINISTIC UI FIXTURE</small><h1>Synthetic shared workspace browser</h1><p>The human and agent share this isolated browser surface.</p><button>Example page action</button><p>No external website, account or provider is used.</p></section>');return (await page.screenshot({type:"jpeg",quality:70})).toString("base64");}finally{await browser.close();}})();
      return {content:[{type:"image",mimeType:"image/jpeg",data:await syntheticBrowserImage}],structuredContent:{id:input.tabId,frameId:"synthetic-frame",width:1280,height:800}};}
    return {structuredContent:{id:input.tabId}};
  },
  async ensureProject() {},
  async releaseAsset() {},
  async stopSession(_project,conversationId) {this.browserTabs.delete(conversationId);},
  async stopProject() {},
  async restoreProject() {},
  async purgeProject() {},
  async steer() {},
  async execute(request, emit, signal) {
    await emit({ type: "started" });
    await emit({ type: "input_accepted" });
    if(request.prompt.includes("[agent-browser]")||request.prompt.includes("[agent-browser-many]")){
      const many=request.prompt.includes("[agent-browser-many]");
      for(let index=0;index<(many?9:2);index++)await this.browser(request.projectId,request.conversationId,{action:"open",url:"https://agent-fixture.invalid/"+(index===0?"":index===1?"second":String(index+1))});
      const tabs=this.browserTabs.get(request.conversationId);if(many)tabs.forEach((tab,index)=>tab.title="Agent page "+(index+1));else{tabs[0].title="Synthetic agent page";tabs[1].title="Second agent page";}
      await emit({type:"assistant_snapshot",text:"Synthetic agent opened the shared browser."});await emit({type:"completed"});return;
    }
    if (
      request.prompt.includes("[history-page-after]") ||
      request.prompt.includes("[retained-reply]")
    ) {
      await emit({
        type: "native_session",
        sessionId: "fixture-retained-" + request.conversationId,
      });
      const later = request.prompt.includes("[history-page-after]");
      if (later)
        for (let index = 0; index < 210; index++) {
          await emit({
            type: "native_update",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "fixture-history-" + index,
              title: "Later retained tool " + index,
              kind: "read",
              status: "completed",
            },
          });
        }
      const text = later
        ? "Later activity is complete"
        : "Retained older response. ".repeat(100) + "END OF OLDER REPLY";
      await emit({
        type: "native_update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
      await emit({ type: "assistant_snapshot", text });
      await emit({ type: "completed" });
      return;
    }
    if (request.prompt.includes("[native-stream]")) {
      const native = (update) => emit({ type: "native_update", update });
      const message = async (text) => {
        await native({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        await emit({ type: "assistant_delta", delta: text });
      };
      await native({
        sessionUpdate: "plan",
        entries: [
          {
            id: "read",
            content: "Inspect the retained record",
            status: "in_progress",
          },
          { id: "verify", content: "Verify the result", status: "pending" },
        ],
        _meta: { wovenPlanKind: "checklist", wovenPlanOperation: "replace" },
      });
      await native({
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "Checking the source and its preserved history.",
        },
        _meta: { wovenThoughtID: "fixture-thought" },
      });
      await message("I will inspect the record and verify the result.");
      await native({ sessionUpdate: "woven_assistant_boundary" });
      await native({
        sessionUpdate: "tool_call",
        toolCallId: "fixture-read",
        title: "Read retained record",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "record.txt" },
      });
      await new Promise((resolve) => setTimeout(resolve, 6000));
      if (signal?.aborted) {
        await emit({ type: "cancelled" });
        return;
      }
      await native({
        sessionUpdate: "tool_call_update",
        toolCallId: "fixture-read",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text:
                "Complete tool output. " +
                "retained row\n".repeat(4000) +
                "FINAL RETAINED ROW",
            },
          },
        ],
      });
      await native({
        sessionUpdate: "woven_subagents",
        subagents: [
          {
            id: 1,
            name: "Verify record",
            state: "completed",
            modelID: request.model,
            result: "The retained record is complete.",
          },
        ],
      });
      await native({
        sessionUpdate: "plan",
        entries: [],
        _meta: { wovenPlanKind: "checklist", wovenPlanOperation: "clear" },
      });
      await message(
        "The record is complete.\n\nAll retained output remains available after reopening this conversation.",
      );
      await native({ sessionUpdate: "woven_assistant_boundary" });
      await emit({
        type: "native_records",
        batch: {
          schemaVersion: 1,
          sourceID: "fixture",
          nativeSessionID: "fixture-session",
          records: [
            {
              id: "fixture-record",
              revision: "1",
              kind: "message",
              text: "Complete fixture archive",
              payload: "Preserved canonical fixture.",
            },
          ],
        },
      });
      await emit({ type: "completed" });
      return;
    }
    if(request.prompt.includes("[html-reply]")) {
      const result=await system.app.inject({method:"POST",url:new URL(request.gateway.baseUrl).pathname+"/workspace/html",headers:{host:new URL(origin).host,authorization:"Bearer "+request.gateway.token},payload:{
        title:"Interactive synthetic reply",height:240,requestID:request.runId,
        html:"<style>body{padding:20px}button{padding:12px}</style><h2>Persistent visual reply</h2><button onclick=\"this.textContent='Interaction verified'\">Try interaction</button><a href='https://example.test/visual'>Example reference</a>",
      }});
      if(result.statusCode!==200)throw new Error("Synthetic HTML publication failed: "+result.statusCode);
      await emit({type:"native_update",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"A persistent visual reply is ready."}}});
      await emit({type:"completed"});return;
    }
    if (request.assetId) {
      const operation = async (payload) => {
        const r = await system.app.inject({
          method: "POST",
          url: new URL(request.gateway.baseUrl).pathname + "/asset",
          headers: {
            host: new URL(origin).host,
            authorization: "Bearer " + request.gateway.token,
          },
          payload,
        });
        if (r.statusCode !== 200)
          throw Error("Synthetic asset operation failed: " + r.statusCode);
        return r.json();
      };
      const context = await operation({ operation: "context" });
      const root = request.mounts.find((m) => m.target === "/workspace").source;
      const n =
        Number(
          await readFile(
            join(root, "asset-" + request.assetId + "-turn.txt"),
            "utf8",
          ).catch(() => 0),
        ) + 1;
      await writeFile(
        join(root, "asset-" + request.assetId + "-data.json"),
        JSON.stringify([{ label: "Generated data", value: n }]),
      );
      await emit({
        type: "tool_start",
        tool: "wme-asset",
        toolId: "fixture-save",
      });
      let sourceText = "";
      for (const source of context.sources.filter((s) =>
        s.path.startsWith("Source-"),
      )) {
        const mount = request.mounts.find(
          (m) =>
            m.target !== "/workspace" &&
            ("/workspace/" + source.path === m.target ||
              ("/workspace/" + source.path).startsWith(m.target + "/")),
        );
        if (!mount || mount.access !== "read")
          throw Error("Fixture selected source must be read-only");
        const rows = JSON.parse(
          await readFile(
            mount.source +
              ("/workspace/" + source.path).slice(mount.target.length),
            "utf8",
          ),
        );
        if (rows[0].label !== "Authorized input" || rows[0].value !== 8)
          throw Error("Fixture source content mismatch");
        sourceText = rows[0].label + ": " + rows[0].value;
      }
      await operation({
        operation: "save",
        operationId: randomUUID(),
        expectedRevision: context.revision,
        document: {
          version: 1,
          blocks: [
            {
              type: "text",
              text:
                n === 1
                  ? "First version for review"
                  : "Second draft kept private",
            },
            ...(sourceText
              ? [
                  {
                    type: "details",
                    title: "Selected source",
                    text: sourceText,
                  },
                ]
              : []),
            {
              type: "table",
              fileId: "workspace:asset-" + request.assetId + "-data.json",
              pointer: "",
              columns: [
                { label: "Item", key: "label" },
                { label: "Count", key: "value" },
              ],
            },
          ],
        },
      });
      await writeFile(
        join(root, "asset-" + request.assetId + "-turn.txt"),
        String(n),
      );
      await emit({
        type: "tool_end",
        tool: "wme-asset",
        toolId: "fixture-save",
        status: "completed",
      });
      await emit({ type: "assistant_delta", delta: "Asset draft saved." });
      await emit({ type: "completed" });
      return;
    }
    for (const delta of [
      "Synthetic protocol fixture: ",
      "the request reached the durable runtime.",
    ]) {
      await new Promise((r) => setTimeout(r, 100));
      if (signal?.aborted) {
        await emit({ type: "cancelled" });
        return;
      }
      await emit({ type: "assistant_delta", delta });
    }
    await emit({ type: "completed" });
  },
  async cancel() {},
  async recover() {
    return [];
  },
};
const system = await buildApp(
  {
    stateDir,
    host: "127.0.0.1",
    port,
    publicOrigin: origin,
    secureCookies: false,
    internalApiOrigin: native?.internalApiOrigin,
    assetIdleMs: process.env.WME_E2E_ASSET_IDLE_MS
      ? Number(process.env.WME_E2E_ASSET_IDLE_MS)
      : 1500,
    hosts: [{ id: "local", name: "Initial host" }],
  },
  { runtime, jobs: false, webRoot },
);
// Deterministic management transport only; real Enterprise authorization and session lifecycle run unchanged.
const remoteAttempts = new Map(),
  connected = [];
const fixtureEndpoint = async () => ({
  baseUrl: native?.providerOrigin ?? "http://fixture.invalid",
  managementKey: "fixture-management",
  clientKey: "fixture-client",
});
system.inference.options.registry.resolve = fixtureEndpoint;
system.inference.proxy = new ProxyClient(
  fixtureEndpoint,
  async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (native && path.startsWith("/v1/")) return fetch(input, init);
    if (path.endsWith("/credentials"))
      return Response.json({ files: connected });
    if (path.endsWith("/observability/usage/api-keys"))
      return Response.json({});
    if (path.endsWith("/oauth/remote")) {
      const { id, provider } = JSON.parse(init.body);
      const attempt = {
        status: "pending",
        provider,
        flow: provider === "claude" ? "manual_code" : "device",
        url:
          provider === "claude"
            ? "https://claude.ai/oauth/authorize?state=fixture"
            : provider === "codex"
              ? "https://auth.openai.com/codex/device"
              : "https://accounts.x.ai/oauth2/device",
        user_code: provider === "claude" ? undefined : "TEST-CODE",
        interval: 5,
        expires_at: new Date(Date.now() + 120000).toISOString(),
      };
      remoteAttempts.set(id, attempt);
      return Response.json(attempt);
    }
    const [, id, operation] =
      path.match(/\/remote\/([^/]+)(?:\/(\w+))?$/) ?? [];
    const attempt = remoteAttempts.get(id);
    if (!attempt) return Response.json({ status: "interrupted" });
    if (init.method === "DELETE") {
      attempt.status = "cancelled";
      return Response.json(attempt);
    }
    if (operation === "code") {
      attempt.status = "ready";
      return Response.json(attempt);
    }
    if (operation === "commit") {
      attempt.status = "complete";
      connected.push({
        name: `fixture-${id}.json`,
        auth_index: id,
        provider: attempt.provider,
        status: "active",
        email: "provider@example.test",
      });
      return Response.json(attempt);
    }
    const controls = JSON.parse(
      await readFile(
        `${process.env.WME_E2E_OUTPUT ?? "/tmp/wme-e2e-evidence"}/provider-control.json`,
        "utf8",
      ).catch(() => "{}"),
    );
    if (controls[id] && attempt.status === "pending")
      attempt.status = controls[id];
    return Response.json(attempt);
  },
);
system.inference.models = async () => [
  {
    id: "gpt-test-fixture",
    name: "Synthetic test model",
    provider: "openai",
    thinkingLevels: ["off", "low", "high"],
  },
  {
    id: "mandatory-thinking-fixture",
    name: "Mandatory reasoning fixture",
    provider: "openrouter",
    thinkingLevels: ["low", "high", "max"],
  },
  {
    id: "no-thinking-fixture",
    name: "No effort control fixture",
    provider: "custom",
    thinkingLevels: [],
  },
  {
    id: "synthetic-asset-pi",
    name: "Asset fixture pi",
    provider: "openai",
  },
];
system.inference.validateSelection = async () => {};

const owner = randomUUID();
await system.ctx.db.run(
  "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES (?,NULL,?,?,?,1,?)",
  [
    owner,
    "owner@example.test",
    "Test Owner",
    "owner",
    new Date().toISOString(),
  ],
);
const session = newSession(owner);
await system.ctx.db.run(session.statement.sql, session.statement.params);
const headers = {
  host: `localhost:${port}`,
  origin,
  cookie: `wme_session=${session.token}`,
  "x-csrf-token": session.csrfToken,
};

await mkdir(output, { recursive: true });
await writeFile(
  join(output, "auth.json"),
  JSON.stringify({
    cookies: [
      {
        name: "wme_session",
        value: session.token,
        domain: "localhost",
        path: "/enterprise",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  }),
  { mode: 0o600 },
);
await writeFile(
  join(output, "fixture.json"),
  JSON.stringify({
    origin,
    database: join(stateDir, "control/platform.sqlite"),
  }),
);
system.jobs.start();
await system.app.listen({ host: "127.0.0.1", port });
console.log(`Synthetic browser fixture ready at ${origin}`);
for (const event of ["SIGINT", "SIGTERM"])
  process.once(event, async () => {
    await system.app.close();
    await native?.close();
    await rm(stateDir, { recursive: true, force: true });
    process.exit(0);
  });
