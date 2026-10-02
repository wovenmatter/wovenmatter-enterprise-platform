import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../apps/api/src/app.js";
import { newSession } from "../../apps/api/src/auth/session.js";
import { mapUser } from "../../apps/api/src/context.js";
import type { Runtime } from "../../packages/runtime/src/types.js";
export async function platformFixture(
  t: TestContext,
  options: {
    stateDir?: string;
    runtime?: Runtime;
  } = {},
) {
  const stateDir =
      options.stateDir ?? (await mkdtemp(join(tmpdir(), "wme-capabilities-"))),
    operations: {
      type: string;
      id: string;
    }[] = [];
  const runtime: Runtime = options.runtime ?? {
    async ensureProject(s) {
      operations.push({
        type: "ensure",
        id: s.projectId,
      });
    },
    async stopProject(s) {
      operations.push({
        type: "stop",
        id: s.projectId,
      });
    },
    async restoreProject(s) {
      operations.push({
        type: "restore",
        id: s.projectId,
      });
    },
    async purgeProject(s) {
      operations.push({
        type: "purge",
        id: s.projectId,
      });
    },
    async execute(_request, emit) {
      await emit({
        type: "started",
      });
      await emit({
        type: "completed",
      });
    },
    async cancel(id) {
      operations.push({
        type: "cancel",
        id,
      });
    },
    async recover() {
      return [];
    },
  };
  const system = await buildApp(
    {
      stateDir,
      publicOrigin: "http://portal.test",
      host: "127.0.0.1",
      port: 4100,
      secureCookies: false,
      hosts: [
        {
          id: "local",
          name: "Initial host",
        },
        {
          id: "second",
          name: "Second host",
        },
      ],
    },
    {
      runtime,
      jobs: false,
      webRoot: join(stateDir, "no-web"),
    },
  );
  t.after(async () => {
    await system.app.close();
    await rm(stateDir, {
      recursive: true,
      force: true,
    });
  });
  const db = system.ctx.db,
    now = new Date().toISOString(),
    orgA = randomUUID(),
    orgB = randomUUID(),
    projectA = randomUUID(),
    projectB = randomUUID();
  for (const [id, name] of [
    [orgA, "Organization A"],
    [orgB, "Organization B"],
  ])
    await db.run(
      "INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
      [id, name, now],
    );
  for (const [id, org] of [
    [projectA, orgA],
    [projectB, orgB],
  ])
    await db.run(
      "INSERT INTO projects(id,org_id,name,status,created_at) VALUES(?,?,?,'ready',?)",
      [id, org, "Workspace", now],
    );
  const users: Record<string, ReturnType<typeof mapUser>> = {},
    headers: Record<string, Record<string, string>> = {};
  for (const [name, org, role] of [
    ["owner", null, "owner"],
    ["admin", orgA, "admin"],
    ["full", orgA, "member"],
    ["read", orgA, "member"],
    ["other", orgB, "admin"],
  ] as const) {
    const id = randomUUID();
    await db.run(
      "INSERT INTO users(id,org_id,email,name,role,enabled,created_at,password_hash) VALUES(?,?,?,?,?,1,?,'fixture-password-hash')",
      [id, org, `${name}@example.test`, name, role, now],
    );
    users[name] = mapUser(await db.get("SELECT * FROM users WHERE id=?", [id]));
    const session = newSession(id);
    await db.run(session.statement.sql, session.statement.params);
    headers[name] = {
      host: "portal.test",
      origin: "http://portal.test",
      cookie: `wme_session=${session.token}`,
      "x-csrf-token": session.csrfToken,
    };
  }
  for (const [name, access] of [
    ["full", "write"],
    ["read", "read"],
  ])
    await db.run("INSERT INTO project_members VALUES(?,?,?,?)", [
      projectA,
      users[name].id,
      access,
      now,
    ]);
  async function request(
    actor: string | undefined,
    method: string,
    url: string,
    payload?: unknown,
  ) {
    return system.app.inject({
      method: method as any,
      url,
      headers: actor
        ? headers[actor]
        : {
            host: "portal.test",
          },
      ...(payload === undefined
        ? {}
        : {
            payload: payload as any,
          }),
    });
  }
  return {
    ...system,
    db,
    stateDir,
    operations,
    users,
    headers,
    orgA,
    orgB,
    projectA,
    projectB,
    request,
  };
}
