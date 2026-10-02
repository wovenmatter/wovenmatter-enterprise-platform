import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTlsSupervisorServer } from "../deploy/supervisor-server.js";
import { createSupervisorClient } from "../deploy/client.js";
import { placedRuntime, readHosts } from "../deploy/placement.js";
import { platformFixture } from "./fixtures/platform.js";
import { uploadFile, readFileVersion } from "../apps/api/src/files/index.js";
import type { RuntimeRequest } from "../packages/runtime/src/types.js";
const exec = promisify(execFile);
test("two real mTLS supervisors authenticate separately, verify actual storage and receive pinned host requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-tls-hosts-"));
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "ca.key"),
    "-out",
    join(root, "ca.crt"),
    "-subj",
    "/CN=Disposable Test CA",
    "-days",
    "1",
  ]);
  await writeFile(
    join(root, "ext"),
    "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n",
  );
  for (const name of ["server", "client"]) {
    await exec("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, name + ".key"),
      "-out",
      join(root, name + ".csr"),
      "-subj",
      "/CN=" + name,
    ]);
    await exec("openssl", [
      "x509",
      "-req",
      "-in",
      join(root, name + ".csr"),
      "-CA",
      join(root, "ca.crt"),
      "-CAkey",
      join(root, "ca.key"),
      "-CAcreateserial",
      "-out",
      join(root, name + ".crt"),
      "-days",
      "1",
      "-extfile",
      join(root, "ext"),
    ]);
  }
  const storage = join(root, "shared");
  await mkdir(storage);
  const hosts = [],
    seen: {
      host: string;
      request: RuntimeRequest;
    }[] = [],
    ensured: string[] = [];
  for (const id of ["local", "second"]) {
    const token = randomBytes(32).toString("hex"),
      tokenFile = join(root, id + ".token");
    await writeFile(tokenFile, token, {
      mode: 0o600,
    });
    const server = createTlsSupervisorServer(
      {
        token,
        hostId: id,
        storageRoot: storage,
        runtime: {
          async updateProject(s) {
            ensured.push("update:" + id + ":" + s.projectId);
          },
          async ensureProject(s) {
            ensured.push(id + ":" + s.projectId);
          },
          async stopProject(s) {
            ensured.push("stop:" + id + ":" + s.projectId);
          },
          async restoreProject(s) {
            ensured.push("restore:" + id + ":" + s.projectId);
          },
          async purgeProject(s) {
            ensured.push("purge:" + id + ":" + s.projectId);
          },
          async execute(request, emit) {
            seen.push({
              host: id,
              request,
            });
            await emit({
              type: "started",
            });
            await emit({
              type: "native_session",
              sessionId: "native-fixture",
            });
            await emit({
              type: "input_accepted",
            });
            await emit({
              type: "assistant_delta",
              delta: "Host accepted",
            });
            await emit({
              type: "completed",
            });
          },
          async cancel() {},
          async stopSession(projectId, conversationId, generation) {
            ensured.push(
              `thread-stop:${id}:${projectId}:${conversationId}:${generation}`,
            );
          },
          async acknowledge() {},
          async recover() {
            return [];
          },
        },
        registry: {
          async ensure() {
            throw new Error("Unused");
          },
          async resolve() {
            throw new Error("Unused");
          },
        },
      },
      {
        key: await readFile(join(root, "server.key")),
        cert: await readFile(join(root, "server.crt")),
        ca: await readFile(join(root, "ca.crt")),
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    hosts.push({
      id,
      name: id,
      hostId: id,
      apiStateRoot: storage,
      supervisorStateRoot: storage,
      storageMode: "shared",
      origin: `https://127.0.0.1:${(server.address() as any).port}`,
      caFile: join(root, "ca.crt"),
      certFile: join(root, "client.crt"),
      keyFile: join(root, "client.key"),
      tokenFile,
    });
  }
  const configs = join(root, "hosts.json");
  await writeFile(configs, JSON.stringify(hosts));
  const parsed = await readHosts(configs);
  let system: Awaited<ReturnType<typeof platformFixture>> | undefined;
  const lookup = async (id: string) => {
    const p = await system?.db.get<any>(
      "SELECT org_id,host_id FROM projects WHERE id=?",
      [id],
    );
    return {
      projectId: id,
      organizationId: p?.org_id ?? "org",
      hostId: p?.host_id ?? (id === "p1" ? "local" : "second"),
    };
  };
  const runtime = placedRuntime(
    parsed,
    lookup,
    async (id) =>
      (
        await system?.db.get<any>(
          "SELECT project_id FROM conversation_runs WHERE id=?",
          [id],
        )
      )?.project_id ?? "p1",
  );
  await runtime.health();
  await runtime.runtime.ensureProject!({
    projectId: "p1",
    organizationId: "org",
    hostId: "local",
  });
  await runtime.runtime.ensureProject!({
    projectId: "p2",
    organizationId: "org",
    hostId: "second",
  });
  assert.deepEqual(ensured, ["local:p1", "second:p2"]);
  for (const [i, projectId] of ["p1", "p2"].entries())
    await runtime.runtime.execute(
      {
        runId: "r" + i,
        projectId,
        organizationId: "org",
        conversationId: "t",
        harness: "codex",
        model: "synthetic",
        prompt: "Synthetic",
        access: "read",
        mounts: [
          {
            source: join(hosts[i].apiStateRoot, "workspaces", projectId),
            target: "/workspace",
            access: "read",
          },
        ],
        sessionDirectory: join(hosts[i].apiStateRoot, "native"),
        gateway: {
          baseUrl: "http://fixture.invalid",
          token: "synthetic",
        },
      },
      () => {},
    );
  assert.deepEqual(
    seen.map((s) => s.host),
    ["local", "second"],
  );
  await assert.rejects(
    createSupervisorClient({
      ...hosts[0],
      tokenFile: hosts[1].tokenFile,
    }).health(),
  );
  await assert.rejects(
    createSupervisorClient({
      ...hosts[0],
      hostId: "second",
    }).health(),
  );
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "rogue.key"),
    "-out",
    join(root, "rogue.crt"),
    "-subj",
    "/CN=Untrusted Client",
    "-days",
    "1",
  ]);
  await assert.rejects(
    createSupervisorClient({
      ...hosts[0],
      certFile: join(root, "rogue.crt"),
      keyFile: join(root, "rogue.key"),
    }).health(),
  );
  const wrong = placedRuntime(
    [
      {
        ...hosts[0],
        apiStateRoot: root,
      },
    ],
    async () => ({
      projectId: "p1",
      organizationId: "org",
      hostId: "local",
    }),
    async () => "p1",
  );
  await assert.rejects(wrong.health());
  await assert.rejects(
    runtime.runtime.execute(
      {
        ...seen[0].request,
        mounts: [
          {
            source: join(root, "outside"),
            target: "/workspace",
            access: "read",
          },
        ],
      },
      () => {},
    ),
    {
      code: "storage_scope",
    },
  );
  await writeFile(
    configs,
    JSON.stringify([
      hosts[0],
      {
        ...hosts[1],
        apiStateRoot: root,
      },
    ]),
  );
  await assert.rejects(readHosts(configs), /independent API roots/);
  // Exercise the real API's own file/session/trash paths through selected host2.
  system = await platformFixture(t, {
    stateDir: storage,
    runtime: runtime.runtime,
  });
  const f = system;
  f.inference.validateSelection = async () => {};
  f.inference.issueGateway = async () => ({
    baseUrl: "http://fixture.invalid",
    token: "synthetic-scoped-fixture",
  });
  await f.request("owner", "PATCH", `/enterprise/api/organizations/${f.orgA}`, {
    defaultHostId: "second",
  });
  const created = await f.request(
    "admin",
    "POST",
    `/enterprise/api/organizations/${f.orgA}/projects`,
    {
      name: "Placed API project",
    },
  );
  assert.equal(created.statusCode, 202);
  const projectId = created.json().id;
  while (await f.jobs.runOnce()) {}
  assert.equal(
    (
      await f.request("admin", "GET", `/enterprise/api/projects/${projectId}`)
    ).json().status,
    "ready",
  );
  assert.ok(ensured.includes("second:" + projectId));
  const file = await uploadFile(
    f.ctx,
    f.users.admin,
    {
      orgId: f.orgA,
      projectId,
    },
    "host-data.txt",
    Buffer.from("current host data"),
  );
  assert.equal(
    (await readFileVersion(f.ctx, f.users.admin, file.id)).bytes.toString(),
    "current host data",
  );
  const c = await f.request(
    "admin",
    "POST",
    `/enterprise/api/projects/${projectId}/conversations`,
    {
      title: "Host thread",
      model: "synthetic",
      harness: "codex",
      mode: "write",
    },
  );
  assert.equal(c.statusCode, 201, c.body);
  const admission = await f.request(
    "admin",
    "POST",
    `/enterprise/api/conversations/${c.json().id}/messages`,
    {
      content: "Host protocol",
      requestId: "host-protocol-request",
    },
  );
  assert.equal(admission.statusCode, 202, admission.body);
  let run: any;
  for (let i = 0; i < 150; i++) {
    run = await f.db.get<any>(
      "SELECT * FROM conversation_runs WHERE conversation_id=?",
      [c.json().id],
    );
    if (run?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(run?.status, "completed");
  assert.equal(run.native_session_id, "native-fixture");
  assert.equal(
    (
      await f.db.get<any>(
        "SELECT delivery FROM conversation_inputs WHERE run_id=?",
        [run.id],
      )
    )?.delivery,
    "accepted",
  );
  const dispatched = seen.find((s) => s.request.projectId === projectId)!;
  assert.equal(dispatched.host, "second");
  assert.ok(
    dispatched.request.mounts[0].source.startsWith(storage + "/workspaces/"),
  );
  assert.ok(
    dispatched.request.sessionDirectory.startsWith(
      storage + "/agent-sessions/",
    ),
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "DELETE",
        `/enterprise/api/projects/${projectId}`,
      )
    ).statusCode,
    202,
  );
  assert.ok(ensured.includes("stop:second:" + projectId));
  const recovered = await f.request(
    "admin",
    "POST",
    `/enterprise/api/deleted-projects/${projectId}/recover-files`,
    {},
  );
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(
    await readFile(
      join(
        storage,
        "workspaces/organizations",
        f.orgA,
        "files",
        recovered.json().path,
        "host-data.txt",
      ),
      "utf8",
    ),
    "current host data",
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${projectId}/restore`,
        {},
      )
    ).statusCode,
    200,
  );
  assert.ok(ensured.includes("restore:second:" + projectId));
  assert.equal(
    (
      await f.request("admin", "GET", `/enterprise/api/projects/${projectId}`)
    ).json().hostId,
    "second",
  );
});
test("owner placement defaults apply only to new projects; admins cannot set hosts or relocate stored projects", async (t) => {
  const f = await platformFixture(t),
    base = `/enterprise/api/organizations/${f.orgA}`;
  assert.equal(
    (
      await f.request("admin", "PATCH", base, {
        defaultHostId: "second",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request("owner", "PATCH", base, {
        defaultHostId: "second",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.request("admin", "POST", base + "/projects", {
        name: "Default",
      })
    ).json().hostId,
    "second",
  );
  assert.equal(
    (
      await f.request("owner", "POST", base + "/projects", {
        name: "Override",
        hostId: "local",
      })
    ).json().hostId,
    "local",
  );
  assert.equal(
    (
      await f.request("admin", "POST", base + "/projects", {
        name: "No",
        hostId: "local",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request(
        "owner",
        "PATCH",
        `/enterprise/api/projects/${f.projectA}`,
        {
          hostId: "second",
        },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.request("owner", "GET", `/enterprise/api/projects/${f.projectA}`)
    ).json().hostId,
    "local",
  );
});
