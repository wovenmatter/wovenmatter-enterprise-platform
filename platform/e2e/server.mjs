// Explicit synthetic acceptance harness. Never imported by the production entrypoint.
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../dist/apps/api/src/app.js";
import { newSession } from "../dist/apps/api/src/auth/session.js";
if (process.env.WME_E2E_FIXTURE !== "1")
  throw new Error("Synthetic acceptance requires WME_E2E_FIXTURE=1");
const port = Number(process.env.WME_E2E_PORT ?? 4155);
const origin = `http://localhost:${port}`;
const stateDir = await mkdtemp(join(tmpdir(), "wme-browser-"));
const webRoot = join(stateDir, "web");
await cp(resolve("platform/apps/web/dist"), webRoot, { recursive: true });
const runtime = {
  async execute(request, emit, signal) {
    await emit({ type: "started" });
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
    contentOriginTemplate: `http://{assetId}.localhost:${port}`,
  },
  { runtime, jobs: false, webRoot },
);
system.inference.models = async () => [
  { id: "gpt-test-fixture", name: "Synthetic test model", provider: "openai" },
];
system.inference.validateSelection = async () => {};
system.inference.issueGateway = async () => ({
  baseUrl: "http://fixture.invalid",
  token: "synthetic-scoped-fixture",
});
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
const output = resolve("platform/.state/e2e");
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "auth.json"),
  JSON.stringify({
    cookies: [
      {
        name: "wme_session",
        value: session.token,
        domain: "localhost",
        path: "/",
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
  }),
);
system.jobs.start();
await system.app.listen({ host: "127.0.0.1", port });
console.log(`Synthetic browser fixture ready at ${origin}`);
for (const event of ["SIGINT", "SIGTERM"])
  process.once(event, async () => {
    await system.app.close();
    await rm(stateDir, { recursive: true, force: true });
    process.exit(0);
  });
