import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrateFoundation } from "../apps/api/src/db/index.js";
import { createContext, AppError, type User } from "../apps/api/src/context.js";
import {
  registerLibrary,
  setLibraryRuntime,
} from "../apps/api/src/library/index.js";
import type {
  LibraryRuntimeHost,
  LibraryRuntimeState,
  LibraryStart,
} from "../apps/api/src/library/runtime.js";
import { organizationHostnameSlug, safePath } from "../apps/api/src/library/model.js";
import { PassThrough } from "node:stream";
import {
  recheckLibrary,
  recoverPublishedLibrary,
} from "../apps/api/src/library/index.js";
import * as files from "../apps/api/src/files/service.js";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

class TestRuntime implements LibraryRuntimeHost {
  resumed: string[] = [];
  async resume(id: string) {
    if (this.state.status !== "running") this.resumed.push(id);
    this.state = { ...this.state, id, status: "running" };
    return { ...this.state };
  }
  starts: LibraryStart[] = [];
  stopped: string[] = [];
  state: LibraryRuntimeState = {
    id: randomUUID(),
    status: "running",
    origin: "http://127.0.0.1:1234/",
  };
  lastHeaders: Headers | undefined;
  upgraded = false;
  async start(input: LibraryStart) {
    this.starts.push(input);
    this.state.id = input.versionId;
    return { ...this.state };
  }
  async stop(id: string) {
    this.stopped.push(id);
  }
  async status() {
    return this.state;
  }
  async fetch(_id: string, path: string, init: RequestInit) {
    this.lastHeaders = new Headers(init.headers);
    return new Response(`Live ${path}`, {
      headers: {
        "content-type": "text/plain",
        "set-cookie": "wme_asset=attacker; Domain=localhost; Path=/",
        "access-control-allow-origin": "*",
      },
    });
  }
  async upgrade(
    _id: string,
    _path: string,
    _headers: Record<string, string>,
    socket: import("node:stream").Duplex,
  ) {
    this.upgraded = true;
    socket.write("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  }
}
async function fixture(t: any, contentOriginTemplate = "http://{assetId}.localhost:4100") {
  const dir = await mkdtemp(join(tmpdir(), "wme-library-")),
    db = await createDatabase(join(dir, "test.sqlite"));
  await migrateFoundation(db);
  const org = randomUUID(),
    other = randomUUID(),
    project = randomUUID(),
    time = new Date().toISOString();
  await db.batch([
    {
      sql: "INSERT INTO organizations VALUES (?,?,?)",
      params: [org, "Firm", time],
    },
    {
      sql: "INSERT INTO organizations VALUES (?,?,?)",
      params: [other, "Other", time],
    },
    {
      sql: "INSERT INTO projects VALUES (?,?,?,?,?,?,?)",
      params: [project, org, "Matter", "", "ready", "write", time],
    },
  ]);
  const users: User[] = [];
  for (const [index, role] of [
    "admin",
    "member",
    "member",
    "member",
    "owner",
  ].entries()) {
    const u: User = {
      id: randomUUID(),
      orgId: index === 4 ? null : index === 3 ? other : org,
      email: `u${index}@example.test`,
      name: `Person ${index}`,
      role: role as User["role"],
      enabled: true,
      theme: "green",
    };
    users.push(u);
    await db.run(
      "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
      [u.id, u.orgId, u.email, u.name, u.role, time],
    );
    if (index === 1)
      await db.run("INSERT INTO project_members VALUES (?,?,?,?)", [
        project,
        u.id,
        "write",
        time,
      ]);
  }
  const ctx = createContext(db, {
    stateDir: dir,
    publicOrigin: "http://portal.localhost:4100",
    contentOriginTemplate,
    host: "127.0.0.1",
    port: 4100,
    secureCookies: false,
  });
  let sessionActive = true;
  ctx.requireUser = async (req) => {
    const u = users.find((x) => x.id === req.headers["x-test-user"]);
    if (!u) throw new AppError(401, "unauthorized", "Sign in");
    return u;
  };
  ctx.getSessionId = async () => "test-session";
  ctx.isSessionActive = async () => sessionActive;
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => {
    const err = e as AppError;
    reply
      .code(err.statusCode ?? 500)
      .send({ error: { code: err.code, message: err.message } });
  });
  const runtime = new TestRuntime();
  setLibraryRuntime(ctx, runtime);
  await registerLibrary(app, ctx);
  await app.ready();
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: any,
    user = users[0],
  ) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: "portal.localhost:4100", "x-test-user": user.id },
    });
  const create = async (
    type: "static" | "live" = "static",
    inProject = false,
  ) => {
    const r = await request("POST", `/api/organizations/${org}/assets`, {
      name: "Report",
      description: "",
      type,
      ...(inProject ? { projectId: project } : {}),
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  const publish = async (
    asset: any,
    content = "First version",
    expectedVersionId: string | null = null,
  ) => {
    const r = await request("POST", `/api/assets/${asset.id}/publish`, {
      expectedVersionId,
      entrypoint: asset.type === "live" ? "server.mjs" : "index.html",
      files: [
        {
          path: asset.type === "live" ? "server.mjs" : "index.html",
          contentBase64: Buffer.from(content).toString("base64"),
        },
      ],
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  const share = async (
    asset: any,
    visibility = "public",
    userIds?: string[],
  ) => {
    const r = await request("POST", `/api/assets/${asset.id}/shares`, {
      visibility,
      ...(userIds ? { userIds } : {}),
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  const enter = async (url: string, user?: User) => {
    const r = await app.inject({
      url: new URL(url).pathname,
      headers: {
        host: "portal.localhost:4100",
        ...(user ? { "x-test-user": user.id } : {}),
      },
    });
    if (r.statusCode !== 302) return { response: r };
    const location = new URL(String(r.headers.location));
    if (location.host === "portal.localhost:4100") return { response: r };
    const exchange = await app.inject({
      url: location.pathname + location.search,
      headers: { host: location.host },
    });
    return {
      response: exchange,
      host: location.host,
      cookie: String(exchange.headers["set-cookie"]).split(";")[0],
      ticketUrl: location.pathname + location.search,
    };
  };
  return {
    app,
    ctx,
    db,
    dir,
    org,
    other,
    project,
    users,
    runtime,
    request,
    create,
    publish,
    share,
    enter,
    revokeSession: () => {
      sessionActive = false;
    },
  };
}
test("immutable public snapshots serve only isolated content host and retain their original revision", async (t) => {
  const f = await fixture(t),
    asset = await f.create(),
    published = await f.publish(asset),
    share = await f.share(asset),
    visit = await f.enter(share.url);
  assert.equal(visit.response.statusCode, 302, visit.response.body);
  const read = () =>
    f.app.inject({
      url: "/",
      headers: { host: visit.host!, cookie: visit.cookie! },
    });
  let content = await read();
  assert.equal(content.statusCode, 200, content.body);
  assert.equal(content.body, "First version");
  assert.match(
    String(content.headers["content-security-policy"]),
    /worker-src 'none'/,
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/",
        headers: { host: "portal.localhost:4100", cookie: visit.cookie! },
      })
    ).statusCode,
    404,
  );
  await f.publish(asset, "Second version", published.version.id);
  content = await read();
  assert.equal(content.body, "First version");
  assert.equal(
    (
      await f.app.inject({
        url: visit.ticketUrl!,
        headers: { host: visit.host! },
      })
    ).statusCode,
    401,
    "ticket is single-use",
  );
  await f.request("DELETE", `/api/assets/${asset.id}/shares/${share.share.id}`);
  assert.equal(
    (await read()).statusCode,
    404,
    "issued grants do not bypass link revocation",
  );
});
test("private selected people and organization links enforce identity every request", async (t) => {
  const f = await fixture(t),
    asset = await f.create();
  await f.publish(asset);
  const selected = await f.share(asset, "people", [f.users[1].id]);
  assert.equal((await f.enter(selected.url)).response.statusCode, 302);
  assert.match(
    String((await f.enter(selected.url)).response.headers.location),
    /returnTo=/,
  );
  assert.equal(
    (await f.enter(selected.url, f.users[2])).response.statusCode,
    403,
  );
  assert.equal(
    (await f.enter(selected.url, f.users[3])).response.statusCode,
    403,
  );
  assert.equal(
    (await f.enter(selected.url, f.users[4])).response.statusCode,
    302,
    "platform owner can inspect",
  );
  const visit = await f.enter(selected.url, f.users[1]);
  assert.equal(visit.response.statusCode, 302);
  const read = () =>
    f.app.inject({
      url: "/",
      headers: { host: visit.host!, cookie: visit.cookie! },
    });
  assert.equal((await read()).statusCode, 200);
  await f.db.run("UPDATE users SET enabled=0 WHERE id=?", [f.users[1].id]);
  assert.equal((await read()).statusCode, 403);
  await f.db.run("UPDATE users SET enabled=1 WHERE id=?", [f.users[1].id]);
  f.revokeSession();
  assert.equal((await read()).statusCode, 401, "portal logout revokes content");
});
test("organization members may view shared assets without raw project membership", async (t) => {
  const f = await fixture(t),
    asset = await f.create("static", true);
  await f.publish(asset);
  const shared = await f.share(asset, "organization"),
    visit = await f.enter(shared.url, f.users[2]);
  assert.equal(visit.response.statusCode, 302);
  assert.equal(
    (await f.request("GET", `/api/assets/${asset.id}`, undefined, f.users[2]))
      .statusCode,
    404,
    "library metadata remains project scoped",
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/",
        headers: { host: visit.host!, cookie: visit.cookie! },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.enter(shared.url, f.users[3])).response.statusCode,
    403,
  );
});
test("project and organization permissions prevent cross-org publication and selection", async (t) => {
  const f = await fixture(t),
    asset = await f.create("static", true);
  assert.equal(
    (await f.request("GET", `/api/assets/${asset.id}`, undefined, f.users[3]))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.request(
        "POST",
        `/api/organizations/${f.org}/assets`,
        { type: "static", name: "Private" },
        f.users[1],
      )
    ).statusCode,
    403,
  );
  await f.publish(asset);
  assert.equal(
    (
      await f.request("POST", `/api/assets/${asset.id}/shares`, {
        visibility: "people",
        userIds: [f.users[3].id],
      })
    ).statusCode,
    400,
  );
  await f.db.run("UPDATE project_members SET access='read' WHERE user_id=?", [
    f.users[1].id,
  ]);
  assert.equal(
    (
      await f.request(
        "PATCH",
        `/api/assets/${asset.id}`,
        { name: "Overwrite" },
        f.users[1],
      )
    ).statusCode,
    403,
  );
});
test("publication rejects stale revision, unsafe paths, duplicate files, and missing entrypoints", async (t) => {
  const f = await fixture(t),
    asset = await f.create();
  const input = {
    expectedVersionId: null,
    files: [{ path: "index.html", contentBase64: "WA==" }],
  };
  for (const path of [
    "../index.html",
    "/etc/passwd",
    ".env",
    "a/../../x",
    "foo\\bar",
  ]) {
    const response = await f.request(
      "POST",
      `/api/assets/${asset.id}/publish`,
      { ...input, files: [{ path, contentBase64: "WA==" }] },
    );
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(
    (
      await f.request("POST", `/api/assets/${asset.id}/publish`, {
        ...input,
        files: [...input.files, ...input.files],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.request("POST", `/api/assets/${asset.id}/publish`, {
        ...input,
        entrypoint: "missing.html",
      })
    ).statusCode,
    400,
  );
  await f.publish(asset);
  assert.equal(
    (await f.request("POST", `/api/assets/${asset.id}/publish`, input))
      .statusCode,
    409,
  );
  assert.throws(() => safePath("x\0y"));
});
test("snapshot tampering fails integrity verification and internal manifest is never served", async (t) => {
  const f = await fixture(t),
    asset = await f.create(),
    published = await f.publish(asset),
    shared = await f.share(asset),
    visit = await f.enter(shared.url);
  const path = join(
    f.dir,
    "library",
    asset.id,
    published.version.id,
    "index.html",
  );
  await chmod(path, 0o644);
  await writeFile(path, "Tampered");
  const headers = { host: visit.host!, cookie: visit.cookie! };
  assert.equal((await f.app.inject({ url: "/", headers })).statusCode, 503);
  assert.equal(
    (await f.app.inject({ url: "/.wme-manifest.json", headers })).statusCode,
    400,
  );
  assert.ok(
    [400, 404].includes(
      (await f.app.inject({ url: "/%2e%2e/secret", headers })).statusCode,
    ),
  );
  const manifestPath = join(
    f.dir,
    "library",
    asset.id,
    published.version.id,
    ".wme-manifest.json",
  );
  await chmod(manifestPath, 0o644);
  await writeFile(
    manifestPath,
    JSON.stringify([
      {
        path: "index.html",
        size: Buffer.byteLength("Tampered"),
        sha256: createHash("sha256").update("Tampered").digest("hex"),
      },
    ]),
  );
  assert.equal(
    (await f.app.inject({ url: "/", headers })).statusCode,
    503,
    "rewriting both content and manifest cannot change a published revision",
  );
});
test("live publication uses isolated host, proxies only live runtime, strips capabilities, revokes and stops", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live"),
    published = await f.publish(asset, 'console.log("server")');
  assert.equal(f.runtime.starts.length, 1);
  assert.equal(
    f.runtime.starts[0].publicOrigin,
    `http://${asset.id}.localhost:4100`,
  );
  assert.equal(published.version.runtimeStatus, "running");
  const share = await f.share(asset),
    visit = await f.enter(share.url);
  const headers = {
    host: visit.host!,
    cookie: `${visit.cookie}; app_session=abc`,
    authorization: "secret",
  };
  const result = await f.app.inject({
    url: "/api/chart?period=month",
    headers,
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.body, "Live /api/chart?period=month");
  assert.equal(f.runtime.lastHeaders?.get("cookie"), "app_session=abc");
  assert.equal(f.runtime.lastHeaders?.get("authorization"), null);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/chart",
        headers,
        payload: { x: 1 },
      })
    ).statusCode,
    403,
  );
  f.runtime.state.status = "stopped";
  assert.equal((await f.app.inject({ url: "/", headers })).statusCode, 503);
  await f.request("DELETE", `/api/assets/${asset.id}`);
  assert.ok(f.runtime.stopped.includes(published.version.runtimeId));
  assert.equal((await f.app.inject({ url: "/", headers })).statusCode, 404);
});
test("failed live startup leaves no published revision", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live");
  f.runtime.state.status = "failed";
  const response = await f.request("POST", `/api/assets/${asset.id}/publish`, {
    expectedVersionId: null,
    files: [{ path: "server.mjs", contentBase64: "WA==" }],
  });
  assert.equal(response.statusCode, 503);
  const current = await f.request("GET", `/api/assets/${asset.id}`);
  assert.equal(current.json().currentVersionId, null);
  assert.deepEqual(current.json().versions, []);
});
test("project deletion immediately denies public links and stops its live applications", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live", true),
    published = await f.publish(asset),
    share = await f.share(asset),
    visit = await f.enter(share.url);
  await f.db.run("UPDATE projects SET status='deleting' WHERE id=?", [
    f.project,
  ]);
  assert.equal(
    (
      await f.app.inject({
        url: "/",
        headers: { host: visit.host!, cookie: visit.cookie! },
      })
    ).statusCode,
    404,
  );
  await recheckLibrary(f.ctx);
  assert.ok(f.runtime.stopped.includes(published.version.runtimeId));
});
test("revoking a link aborts an idle application request before response headers", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live");
  await f.publish(asset);
  const share = await f.share(asset),
    visit = await f.enter(share.url);
  let started = false,
    aborted = false;
  f.runtime.fetch = async (_id, _path, init) => {
    started = true;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  };
  const pending = f.app
    .inject({
      url: "/waiting",
      headers: { host: visit.host!, cookie: visit.cookie! },
    })
    .then((r) => r);
  while (!started) await new Promise((r) => setTimeout(r, 5));
  await f.request("DELETE", `/api/assets/${asset.id}/shares/${share.share.id}`);
  const result = await pending;
  assert.equal(result.statusCode, 403);
  assert.equal(aborted, true);
});
test("idle WebSocket authorization is rechecked and revocation closes the connection", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live");
  await f.publish(asset);
  const share = await f.share(asset),
    visit = await f.enter(share.url),
    socket = new PassThrough();
  f.app.server.emit(
    "upgrade",
    {
      headers: {
        host: visit.host!,
        cookie: visit.cookie!,
        origin: `http://${visit.host}`,
        "sec-websocket-key": "test",
        "sec-websocket-version": "13",
      },
      url: "/socket",
    },
    socket,
    Buffer.alloc(0),
  );
  for (let n = 0; n < 100 && !f.runtime.upgraded; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.runtime.upgraded, true);
  await f.request("DELETE", `/api/assets/${asset.id}/shares/${share.share.id}`);
  for (let n = 0; n < 200 && !socket.destroyed; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(socket.destroyed, true);
});
test("revoked organization source share stops live access without granting viewers file rights", async (t) => {
  const f = await fixture(t);
  await files.initializeFiles(f.ctx);
  const folder = await files.createFolder(
    f.ctx,
    f.users[0],
    { orgId: f.org },
    "Inputs",
  );
  await files.uploadFile(
    f.ctx,
    f.users[0],
    { orgId: f.org },
    "Inputs/chart.csv",
    Buffer.from("x,y\n1,2"),
  );
  await files.shareFile(
    f.ctx,
    f.users[0],
    folder.id,
    f.project,
    "read",
    "Inputs",
  );
  const asset = await f.create("live", true);
  const result = await f.request("POST", `/api/assets/${asset.id}/publish`, {
    expectedVersionId: null,
    dataFileIds: [folder.id],
    files: [{ path: "server.mjs", contentBase64: "WA==" }],
  });
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(f.runtime.starts[0].dataMounts[0].readOnly, true);
  const share = await f.share(asset),
    visit = await f.enter(share.url);
  await files.revokeShare(f.ctx, f.users[0], folder.id, f.project);
  assert.equal(
    (
      await f.app.inject({
        url: "/",
        headers: { host: visit.host!, cookie: visit.cookie! },
      })
    ).statusCode,
    403,
  );
  await recheckLibrary(f.ctx);
  assert.ok(f.runtime.stopped.includes(result.json().version.runtimeId));
});
test("same-path folder replacement is detected instead of serving a stale bind mount", async (t) => {
  const f = await fixture(t);
  await files.initializeFiles(f.ctx);
  const folder = await files.createFolder(
    f.ctx,
    f.users[0],
    { orgId: f.org },
    "Inputs",
  );
  const asset = await f.create("live");
  const result = await f.request("POST", `/api/assets/${asset.id}/publish`, {
    expectedVersionId: null,
    dataFileIds: [folder.id],
    files: [{ path: "server.mjs", contentBase64: "WA==" }],
  });
  assert.equal(result.statusCode, 201, result.body);
  const mount = f.runtime.starts[0].dataMounts[0];
  await rename(mount.source, `${mount.source}-old`);
  await mkdir(mount.source);
  await recheckLibrary(f.ctx);
  assert.ok(f.runtime.stopped.includes(result.json().version.runtimeId));
});
test("linked folder permission revoked during runtime startup prevents publication", async (t) => {
  const f = await fixture(t);
  await files.initializeFiles(f.ctx);
  const folder = await files.createFolder(
    f.ctx,
    f.users[0],
    { orgId: f.org },
    "Inputs",
  );
  await files.shareFile(
    f.ctx,
    f.users[0],
    folder.id,
    f.project,
    "read",
    "Inputs",
  );
  const asset = await f.create("live", true);
  const originalStart = f.runtime.start.bind(f.runtime);
  f.runtime.start = async (input) => {
    const state = await originalStart(input);
    await files.revokeShare(f.ctx, f.users[0], folder.id, f.project);
    return state;
  };
  const result = await f.request("POST", `/api/assets/${asset.id}/publish`, {
    expectedVersionId: null,
    dataFileIds: [folder.id],
    files: [{ path: "server.mjs", contentBase64: "WA==" }],
  });
  assert.equal(result.statusCode, 403, result.body);
  assert.equal(
    (await f.request("GET", `/api/assets/${asset.id}`)).json().currentVersionId,
    null,
  );
  assert.ok(f.runtime.stopped.includes(f.runtime.state.id));
});
test("individual file data bindings are rejected so atomic replacements cannot become stale", async (t) => {
  const f = await fixture(t);
  await files.initializeFiles(f.ctx);
  const file = await files.uploadFile(
    f.ctx,
    f.users[0],
    { orgId: f.org },
    "data.csv",
    Buffer.from("x,y"),
  );
  const asset = await f.create("live");
  const result = await f.request("POST", `/api/assets/${asset.id}/publish`, {
    expectedVersionId: null,
    dataFileIds: [file.id],
    files: [{ path: "server.mjs", contentBase64: "WA==" }],
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().error.code, "data_folder_required");
});
test("durable abandoned launch cleanup stops uncertain startup without republishing", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live"),
    id = randomUUID();
  await f.db.run("INSERT INTO library_launches VALUES (?,?,?)", [
    id,
    asset.id,
    new Date(Date.now() - 180_000).toISOString(),
  ]);
  await recheckLibrary(f.ctx);
  assert.ok(f.runtime.stopped.includes(id));
  assert.equal(
    await f.db.get("SELECT id FROM library_launches WHERE id=?", [id]),
    undefined,
  );
  assert.equal(
    (await f.request("GET", `/api/assets/${asset.id}`)).json().currentVersionId,
    null,
  );
});
test("shutdown closes idle HTTP and upgraded WebSocket connections before server drain", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live");
  await f.publish(asset);
  const share = await f.share(asset),
    visit = await f.enter(share.url);
  let fetchStarted = false,
    fetchAborted = false;
  f.runtime.fetch = async (_id, _path, init) => {
    fetchStarted = true;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          fetchAborted = true;
          reject(new Error("Shutdown aborted application request"));
        },
        { once: true },
      );
    });
  };
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (f.app.server.address() as import("node:net").AddressInfo).port;
  const http = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/idle",
      headers: { host: visit.host!, cookie: visit.cookie! },
    },
    (response) => response.resume(),
  );
  http.on("error", () => {});
  http.end();
  const ws = connect({ host: "127.0.0.1", port });
  ws.on("error", () => {});
  ws.on("data", () => {});
  await new Promise<void>((resolve) => ws.once("connect", resolve));
  ws.write(
    `GET /socket HTTP/1.1\r\nHost: ${visit.host}\r\nCookie: ${visit.cookie}\r\nOrigin: http://${visit.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  for (let n = 0; n < 200 && (!fetchStarted || !f.runtime.upgraded); n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetchStarted, true);
  assert.equal(f.runtime.upgraded, true);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      f.app.close(),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error("Library shutdown failed to drain within two seconds"),
            ),
          2000,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    http.destroy();
    ws.destroy();
  }
  assert.equal(fetchAborted, true);
});
test("startup resumes only confirmed stopped current applications and confirms running ones without replay", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live"),
    published = await f.publish(asset);
  f.runtime.state.status = "stopped";
  await recoverPublishedLibrary(f.ctx);
  assert.deepEqual(f.runtime.resumed, [published.version.runtimeId]);
  await recoverPublishedLibrary(f.ctx);
  assert.equal(f.runtime.resumed.length, 1);
  const detail = await f.request("GET", `/api/assets/${asset.id}`);
  assert.equal(detail.json().versions[0].runtimeStatus, "running");
});
test("interrupted recovery requires explicit authorized retry rather than automatically replaying", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live"),
    published = await f.publish(asset);
  f.runtime.state.status = "stopped";
  await f.db.run(
    "UPDATE library_versions SET runtime_status='resuming' WHERE id=?",
    [published.version.id],
  );
  await recoverPublishedLibrary(f.ctx);
  assert.equal(f.runtime.resumed.length, 0);
  let detail = await f.request("GET", `/api/assets/${asset.id}`);
  assert.equal(detail.json().versions[0].runtimeStatus, "needs_attention");
  assert.equal(detail.json().versions[0].runtimeError, "interrupted_recovery");
  assert.equal(
    (
      await f.request(
        "POST",
        `/api/assets/${asset.id}/resume`,
        { expectedVersionId: published.version.id },
        f.users[3],
      )
    ).statusCode,
    404,
  );
  const retried = await f.request("POST", `/api/assets/${asset.id}/resume`, {
    expectedVersionId: published.version.id,
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().version.runtimeStatus, "running");
  assert.equal(f.runtime.resumed.length, 1);
});
test("failed startup recovery is surfaced once and not repeatedly retried by access checks", async (t) => {
  const f = await fixture(t),
    asset = await f.create("live");
  await f.publish(asset);
  f.runtime.state.status = "stopped";
  let attempts = 0;
  f.runtime.resume = async () => {
    attempts++;
    throw new Error("Supervisor unavailable");
  };
  await recoverPublishedLibrary(f.ctx);
  await recoverPublishedLibrary(f.ctx);
  await recheckLibrary(f.ctx);
  assert.equal(attempts, 1);
  const detail = await f.request("GET", `/api/assets/${asset.id}`);
  assert.equal(detail.json().versions[0].runtimeStatus, "needs_attention");
  assert.equal(detail.json().versions[0].runtimeError, "resume_failed");
});


test("organization asset hostnames persist across renames and reject a different prefix", async (t) => {
  const f = await fixture(t, "http://{orgSlug}-{assetId}.localhost:4100");
  const asset = await f.create();
  await f.publish(asset);
  const share = await f.share(asset);
  const visit = await f.enter(share.url);
  assert.equal(visit.response.statusCode, 302, visit.response.body);
  assert.equal(visit.host, `firm-${asset.id}.localhost:4100`);
  const good = await f.app.inject({url:"/", headers:{host:visit.host!,cookie:visit.cookie!}});
  assert.equal(good.statusCode, 200, good.body);
  const wrong = await f.app.inject({url:"/", headers:{host:`other-${asset.id}.localhost:4100`,cookie:visit.cookie!}});
  assert.equal(wrong.statusCode, 404, wrong.body);
  await f.db.run("UPDATE organizations SET name=? WHERE id=?", ["New Organization",f.org]);
  const again = await f.enter(share.url);
  assert.equal(again.host, visit.host);
  const next = await f.create();
  await f.publish(next);
  assert.equal((await f.enter((await f.share(next)).url)).host, `new-organization-${next.id}.localhost:4100`);
});

test("organization slugs are bounded ASCII DNS labels with safe fallback", () => {
  assert.equal(organizationHostnameSlug("  Société & Partners  "), "societe-partners");
  assert.equal(organizationHostnameSlug("你好"), "org");
  assert.equal(organizationHostnameSlug("A".repeat(200)).length + 1 + 36, 63);
  assert.match(organizationHostnameSlug("A very long organization name with punctuation!"), /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
});
