// Operator-invoked synthetic API acceptance against an isolated candidate only.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
if (
  process.env.WME_RUN_CANDIDATE_ACCEPTANCE !== "1" ||
  !process.env.WME_STATE_DIR?.includes("candidate")
)
  throw new Error("Explicit isolated candidate state is required");
const state = process.env.WME_STATE_DIR,
  origin = new URL(process.env.WME_PUBLIC_ORIGIN),
  apiOrigin = process.env.WME_ACCEPTANCE_API_ORIGIN;
if (
  !apiOrigin ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(apiOrigin).hostname)
)
  throw new Error("Set an explicit loopback candidate API origin");
const db = new DatabaseSync(join(state, "control/platform.sqlite")),
  org = randomUUID(),
  foreign = randomUUID(),
  admin = randomUUID(),
  outside = randomUUID(),
  now = new Date().toISOString(),
  csrf = randomBytes(32).toString("hex"),
  sessions = [];
db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000");
for (const [id, name] of [
  [org, "Synthetic acceptance"],
  [foreign, "Unrelated synthetic tenant"],
])
  db.prepare("INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)").run(
    id,
    name,
    now,
  );
for (const [id, organization] of [
  [admin, org],
  [outside, foreign],
]) {
  db.prepare(
    "INSERT INTO users(id,org_id,email,name,role,enabled,created_at,password_hash) VALUES(?,?,?,'Synthetic admin','admin',1,?,'fixture-only')",
  ).run(id, organization, id + "@example.test", now);
  const token = randomBytes(32).toString("hex");
  sessions.push(token);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    id,
    csrf,
    new Date(Date.now() + 3600000).toISOString(),
    now,
  );
}
async function call(path, { method = "GET", body, actor = 0 } = {}) {
  const response = await fetch(new URL(path, apiOrigin), {
    method,
    headers: {
      host: origin.host,
      origin: origin.origin,
      "x-csrf-token": csrf,
      ...(actor === null
        ? {}
        : {
            cookie: `${origin.protocol === "https:" ? "__Host-wme_session" : "wme_session"}=${sessions[actor]}`,
          }),
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
          }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
  };
}
const ok = (r) => {
  assert.ok(r.status >= 200 && r.status < 300, `Unexpected HTTP ${r.status}`);
  return r.json;
};
let project;
try {
  ok(await call("/enterprise/healthz"));
  assert.equal((await call("/api/session")).status, 404);
  project = ok(
    await call(`/enterprise/api/organizations/${org}/projects`, {
      method: "POST",
      body: {
        name: "Synthetic persistent workspace",
      },
    }),
  );
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (
      ok(await call(`/enterprise/api/projects/${project.id}`)).status ===
      "ready"
    ) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, "Project did not become ready");
  const report = ok(
    await call(`/enterprise/api/organizations/${org}/assets`, {
      method: "POST",
      body: {
        projectId: project.id,
        name: "Safe acceptance report",
        document: {
          version: 1,
          blocks: [
            {
              type: "text",
              text: "<script>inert</script>",
            },
          ],
        },
      },
    }),
  );
  assert.equal(
    (
      await call(report.url, {
        actor: null,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(report.url, {
        actor: 1,
      })
    ).status,
    404,
  );
  ok(
    await call(`/enterprise/api/assets/${report.id}`, {
      method: "PATCH",
      body: {
        visibility: "public",
      },
    }),
  );
  const publicPage = await call(report.url, {
    actor: null,
  });
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.text, /&lt;script&gt;/);
  assert.doesNotMatch(publicPage.text, /<script|<form/);
  assert.match(
    publicPage.headers.get("content-security-policy"),
    /script-src 'none'/,
  );
  ok(
    await call(`/enterprise/api/projects/${project.id}`, {
      method: "DELETE",
    }),
  );
  assert.equal(
    (
      await call(report.url, {
        actor: null,
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(`/enterprise/api/projects/${project.id}`)).status,
    404,
  );
  assert.ok(
    ok(
      await call(`/enterprise/api/organizations/${org}/deleted-projects`),
    ).items.some((p) => p.id === project.id),
  );
  ok(
    await call(`/enterprise/api/deleted-projects/${project.id}/restore`, {
      method: "POST",
      body: {},
    }),
  );
  assert.equal(
    ok(await call(`/enterprise/api/projects/${project.id}`)).hostId,
    project.hostId,
  );
  await writeFile(
    join(state, "acceptance-manifest.json"),
    JSON.stringify({
      organizationId: org,
      projectId: project.id,
      reportId: report.id,
      providerInference: false,
    }),
    {
      mode: 0o600,
    },
  );
  console.log(
    "Candidate API passed: project readiness, tenant/report scopes, inert HTML, immediate deletion and pinned restore. No provider or SMTP operation.",
  );
} finally {
  if (project)
    await call(`/enterprise/api/projects/${project.id}`, {
      method: "DELETE",
    }).catch(() => {});
  db.prepare("DELETE FROM sessions WHERE user_id IN (?,?)").run(admin, outside);
  db.close();
}
