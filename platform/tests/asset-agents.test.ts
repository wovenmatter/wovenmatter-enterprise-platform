import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { platformFixture } from "./fixtures/platform.js";
import { purgeExpiredProject } from "../apps/api/src/projects/trash.js";
import {
  uploadFile,
  shareFile,
  revokeShare,
} from "../apps/api/src/files/service.js";
import type {
  EventSink,
  Runtime,
  RuntimeRequest,
  ProjectRuntimeSpec,
} from "../packages/runtime/src/types.js";

const document = (text: string) => ({
  version: 1,
  blocks: [{ type: "text", text }],
});
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Fixture condition not reached");
}
async function fixture(t: TestContext) {
  const turns = new Map<
      string,
      { request: RuntimeRequest; emit: EventSink; finish: () => void }
    >(),
    ensured: ProjectRuntimeSpec[] = [],
    released: ProjectRuntimeSpec[] = [],
    stops: string[] = [],
    cancellations: string[] = [];
  const runtime: Runtime = {
    async ensureProject(s) {
      ensured.push(s);
    },
    async releaseAsset(s) {
      released.push(s);
    },
    async execute(request, emit, signal) {
      await emit({ type: "started" });
      await emit({ type: "input_accepted" });
      await new Promise<void>((finish) => {
        turns.set(request.runId, { request, emit, finish });
        signal?.addEventListener("abort", () => finish(), { once: true });
      });
    },
    async cancel(id) {
      cancellations.push(id);
      const turn = turns.get(id);
      if (turn) {
        await turn.emit({ type: "cancelled" });
        turn.finish();
      }
    },
    async stopSession(_project, id) {
      stops.push(id);
      for (const t of turns.values())
        if (t.request.conversationId === id) t.finish();
    },
    async recover() {
      return [];
    },
    async steer() {},
  };
  const f = await platformFixture(t, { runtime });
  const settled = new Set<string>(),
    settle = f.assetAgents.settled.bind(f.assetAgents);
  f.assetAgents.settled = async (run) => {
    await settle(run);
    settled.add(run.id);
  };
  f.inference.models = async () => [
    { id: "fixture-model", name: "Fixture", provider: "openai" },
  ];
  f.inference.validateSelection = async () => {};
  const endpoint = async () => ({
    baseUrl: "http://inference.example.test",
    managementKey: "fixture-management",
    clientKey: "fixture-client",
  });
  f.inference.options.registry.resolve = endpoint;

  async function create(projectId?: string, actor = "admin") {
    const r = await f.request(
      actor,
      "POST",
      `/enterprise/api/organizations/${f.orgA}/assets`,
      { name: "Agent asset", draft: true, projectId },
    );
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  }
  async function conversation(assetId: string, actor = "admin") {
    const r = await f.request(
      actor,
      "POST",
      `/enterprise/api/assets/${assetId}/agent`,
      { model: "fixture-model", harness: "codex" },
    );
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  async function prompt(id: string, actor = "admin", requestId = randomUUID()) {
    const r = await f.request(
      actor,
      "POST",
      `/enterprise/api/conversations/${id}/messages`,
      { content: "Prepare my draft", requestId },
    );
    assert.equal(r.statusCode, 202, r.body);
    const run = await f.db.get<{ id: string }>(
      "SELECT id FROM conversation_runs WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
      [id],
    );
    await until(async () => turns.has(run!.id));
    return turns.get(run!.id)!;
  }
  async function operation(turn: { request: RuntimeRequest }, body: unknown) {
    return f.app.inject({
      method: "POST",
      url: new URL(turn.request.gateway.baseUrl).pathname + "/asset",
      headers: {
        host: "portal.test",
        authorization: "Bearer " + turn.request.gateway.token,
      },
      payload: body as any,
    });
  }
  async function save(
    turn: { request: RuntimeRequest },
    revision: number,
    doc: unknown,
    operationId = randomUUID(),
  ) {
    return operation(turn, {
      operation: "save",
      operationId,
      expectedRevision: revision,
      document: doc,
    });
  }
  async function complete(turn: {
    request: RuntimeRequest;
    emit: EventSink;
    finish: () => void;
  }) {
    await turn.emit({ type: "completed" });
    turn.finish();
    await until(
      async () =>
        (
          await f.db.get<{ status: string }>(
            "SELECT status FROM conversation_runs WHERE id=?",
            [turn.request.runId],
          )
        )?.status === "completed",
    );
    if (turn.request.assetId)
      await until(async () => settled.has(turn.request.runId));
  }
  return {
    ...f,
    runtime,
    turns,
    ensured,
    released,
    stops,
    cancellations,
    create,
    conversation,
    prompt,
    operation,
    save,
    complete,
  };
}

test("asset prompt uses admitted run capability, validates and saves preview, and publishes only explicitly", async (t) => {
  const f = await fixture(t),
    a = await f.create(),
    c = await f.conversation(a.id);
  assert.equal(
    f.ensured.length,
    0,
    "opening asset/conversation starts no compute",
  );
  assert.equal(
    (await f.db.get<{ n: number }>("SELECT COUNT(*) n FROM asset_workspaces"))!
      .n,
    0,
  );
  const turn = await f.prompt(c.id);
  assert.equal(f.ensured.length, 1);
  assert.deepEqual(f.ensured[0].owner, { kind: "asset", assetId: a.id });
  assert.equal(turn.request.projectId, "asset-" + a.id);
  assert.equal(turn.request.assetId, a.id);
  assert.equal(turn.request.mounts.length, 1);
  assert.match(
    turn.request.mounts[0].source,
    new RegExp(`/assets/${a.id}/files$`),
  );
  assert.equal(turn.request.mounts[0].access, "write");
  assert.equal(
    (await f.db.get<{ n: number }>("SELECT COUNT(*) n FROM projects"))!.n,
    2,
    "no fake project added",
  );
  const context = await f.operation(turn, { operation: "context" });
  assert.equal(context.statusCode, 200, context.body);
  const revision = context.json().revision,
    operationId = randomUUID();
  const invalid = await f.save(turn, revision, {
    version: 1,
    blocks: [{ type: "script", text: "evil()" }],
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(
    (await f.request("admin", "GET", `/enterprise/api/assets/${a.id}`)).json()
      .revision,
    revision,
  );
  const saved = await f.save(
    turn,
    revision,
    document("Prepared by the admitted agent"),
    operationId,
  );
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    (
      await f.save(
        turn,
        revision,
        document("Prepared by the admitted agent"),
        operationId,
      )
    ).json().duplicate,
    true,
  );
  assert.equal(
    (await f.save(turn, revision, document("Lost edit"))).statusCode,
    409,
  );
  assert.equal(
    (await f.save(turn, revision, document("Identity collision"), operationId))
      .statusCode,
    409,
  );
  const preview = await f.request("admin", "GET", a.url + "/preview");
  assert.equal(preview.statusCode, 200, preview.body);
  assert.match(preview.body, /Prepared by the admitted agent/);
  assert.match(
    String(preview.headers["content-security-policy"]),
    /script-src 'none'/,
  );
  assert.match(
    String(preview.headers["content-security-policy"]),
    /frame-ancestors 'self'/,
  );
  assert.equal(preview.headers["x-frame-options"], undefined);
  assert.equal((await f.request(undefined, "GET", a.url)).statusCode, 404);
  assert.equal(
    (await f.request("read", "GET", a.url + "/preview")).statusCode,
    403,
  );
  const events = await f.db.all(
    "SELECT * FROM conversation_events WHERE conversation_id=? AND type='asset.saved'",
    [c.id],
  );
  assert.equal(events.length, 1);
  let published = await f.request(
    "admin",
    "POST",
    `/enterprise/api/assets/${a.id}/publish`,
    { expectedRevision: revision + 1, visibility: "public" },
  );
  assert.equal(published.statusCode, 200, published.body);
  assert.match(
    (await f.request(undefined, "GET", a.url)).body,
    /Prepared by the admitted agent/,
  );
  const next = published.json().revision;
  assert.equal(
    (await f.save(turn, next, document("Next private draft"))).statusCode,
    200,
  );
  assert.doesNotMatch(
    (await f.request(undefined, "GET", a.url)).body,
    /Next private draft/,
  );
  await f.complete(turn);
  assert.equal(
    (await f.operation(turn, { operation: "context" })).statusCode,
    403,
    "settled capability revoked",
  );
});

test("generated output is privately snapshotted, survives idle/reopen and cannot be read through library or other assets", async (t) => {
  const f = await fixture(t),
    a = await f.create(),
    c = await f.conversation(a.id),
    turn = await f.prompt(c.id),
    root = turn.request.mounts[0].source;
  await writeFile(
    join(root, "data.json"),
    '[{"label":"Retained result","value":42}]',
  );
  const draft = {
    version: 1,
    blocks: [
      {
        type: "table",
        fileId: "workspace:data.json",
        pointer: "",
        columns: [
          { label: "Result", key: "label" },
          { label: "Value", key: "value" },
        ],
      },
    ],
  };
  const result = await f.save(turn, a.revision, draft);
  assert.equal(result.statusCode, 200, result.body);
  const stored = (
      await f.request("admin", "GET", `/enterprise/api/assets/${a.id}`)
    ).json(),
    fileId = stored.document.blocks[0].fileId;
  assert.match(fileId, /^af_/);
  assert.equal(
    (await f.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM workspace_files WHERE project_id IS NULL",
    ))!.n,
    0,
  );
  for (const actor of [undefined, "admin", "read", "other"]) {
    assert.ok(
      (await f.request(actor, "GET", `/enterprise/api/files/${fileId}/content`))
        .statusCode >= 400,
    );
  }
  const published = await f.request(
    "admin",
    "POST",
    `/enterprise/api/assets/${a.id}/publish`,
    { expectedRevision: stored.revision, visibility: "public" },
  );
  assert.equal(published.statusCode, 200, published.body);
  await writeFile(
    join(root, "data.json"),
    '[{"label":"Unpublished scratch","value":13}]',
  );
  assert.match(
    (await f.request(undefined, "GET", a.url)).body,
    /Retained result/,
  );
  assert.doesNotMatch(
    (await f.request(undefined, "GET", a.url)).body,
    /Unpublished scratch/,
  );
  await f.complete(turn);
  await f.db.run(
    "UPDATE asset_workspaces SET last_activity=0 WHERE asset_id=?",
    [a.id],
  );
  await f.assetAgents.maintenance();
  assert.equal(f.released.length, 1);
  assert.equal((await f.assetAgents.detail(f.users.admin, a.id)).state, "idle");
  assert.match(
    await readFile(join(root, "data.json"), "utf8"),
    /Unpublished scratch/,
  );
  const later = await f.prompt(c.id);
  assert.equal(later.request.mounts[0].source, root);
  assert.equal(later.request.workspaceLease, turn.request.workspaceLease! + 1);
  assert.match(later.request.prompt, /Prepare my draft/);
  const b = await f.create(),
    bc = await f.conversation(b.id),
    bt = await f.prompt(bc.id);
  assert.equal(
    (
      await f.save(bt, b.revision, {
        ...draft,
        blocks: [{ ...draft.blocks[0], fileId }],
      })
    ).statusCode,
    404,
  );
  await f.complete(later);
  await f.complete(bt);
});

test("linked asset runs share the existing project with siblings; their private history and Stop never lend full authority", async (t) => {
  const f = await fixture(t),
    a = await f.create(f.projectA, "full"),
    c = await f.conversation(a.id, "full");
  const ordinary = await f.request(
    "full",
    "POST",
    `/enterprise/api/projects/${f.projectA}/conversations`,
    {
      title: "Ordinary private session",
      model: "fixture-model",
      harness: "codex",
      mode: "write",
    },
  );
  assert.equal(ordinary.statusCode, 201, ordinary.body);
  const sibling = await f.prompt(ordinary.json().id, "full"),
    assetTurn = await f.prompt(c.id, "full");
  assert.equal(assetTurn.request.projectId, f.projectA);
  assert.equal(
    assetTurn.request.mounts[0].source,
    sibling.request.mounts[0].source,
  );
  assert.equal(f.ensured.length, 0);
  assert.equal(
    (await f.request("read", "GET", `/enterprise/api/conversations/${c.id}`))
      .statusCode,
    403,
  );
  assert.equal(
    (await f.request("other", "GET", `/enterprise/api/assets/${a.id}/agent`))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.request(
        "full",
        "POST",
        `/enterprise/api/conversations/${c.id}/members`,
        { userId: f.users.read.id },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.operation(sibling, { operation: "context" })).statusCode,
    403,
  );
  assert.equal(
    (await f.request("full", "DELETE", `/enterprise/api/assets/${a.id}`))
      .statusCode,
    200,
  );
  assert.ok(f.stops.includes(c.id));
  assert.ok(!f.stops.includes(ordinary.json().id));
  assert.ok(!f.cancellations.includes(sibling.request.runId));
  assert.equal(f.released.length, 0);
  assert.equal(
    (await f.operation(assetTurn, { operation: "context" })).statusCode,
    403,
  );
  await f.complete(sibling);
});

test("current actor and selected source revocation fence saves and retire native work, including idle environments", async (t) => {
  const f = await fixture(t),
    source = await uploadFile(
      f.ctx,
      f.users.admin,
      { orgId: f.orgA },
      "input.json",
      Buffer.from('[{"value":9}]'),
    );
  const a = await f.create(),
    c = await f.conversation(a.id),
    turn = await f.prompt(c.id);
  const doc = {
    version: 1,
    blocks: [
      {
        type: "table",
        fileId: source.id,
        pointer: "",
        columns: [{ label: "Value", key: "value" }],
      },
    ],
  };
  assert.equal(
    (await f.save(turn, a.revision, doc)).statusCode,
    403,
    "unselected org source denied",
  );
  await f.complete(turn);
  assert.equal(
    (
      await f.request(
        "admin",
        "PUT",
        `/enterprise/api/assets/${a.id}/sources`,
        { fileIds: [source.id] },
      )
    ).statusCode,
    200,
  );
  const next = await f.prompt(c.id);
  assert.equal(next.request.mounts[1].access, "read");
  await next.emit({
    type: "citation",
    fileId: source.id,
    versionId: source.versionId!,
  });
  const messages = await f.conversations.messages(f.users.admin, c.id);
  const citation = messages.items
    .flatMap((m) => m.citations)
    .find((c) => c.fileId === source.id)!;
  assert.ok(citation);
  assert.ok(!citation.url.includes("projectId="));
  assert.equal((await f.request("admin", "GET", citation.url)).statusCode, 200);

  assert.equal((await f.save(next, a.revision, doc)).statusCode, 200);
  const third = await f.create(),
    tc = await f.conversation(third.id),
    tt = await f.prompt(tc.id);
  await f.db.run(
    "DELETE FROM organization_memberships WHERE user_id=? AND org_id=?",
    [f.users.admin.id, f.orgA],
  );
  assert.equal(
    (await f.operation(tt, { operation: "context" })).statusCode,
    403,
  );
  await f.conversations.recheckAccess();
  assert.ok(f.stops.includes(c.id));
  assert.ok(f.stops.includes(tc.id));
  assert.equal(
    (await f.request("admin", "GET", a.url + "/preview")).statusCode,
    404,
  );
});

test("a share removed between read validation and atomic draft commit cannot be saved", async (t) => {
  const f = await fixture(t),
    source = await uploadFile(
      f.ctx,
      f.users.admin,
      { orgId: f.orgA },
      "shared.json",
      Buffer.from('[{"value":9}]'),
    );
  await shareFile(
    f.ctx,
    f.users.admin,
    source.id,
    f.projectA,
    "read",
    "Shared",
  );
  const a = await f.create(f.projectA, "full"),
    c = await f.conversation(a.id, "full"),
    turn = await f.prompt(c.id, "full");
  const original = f.db.batch;
  f.db.batch = async (statements) => {
    if (
      statements.some((s) =>
        s.sql.includes("UPDATE reports SET draft_document"),
      )
    ) {
      f.db.batch = original;
      await revokeShare(f.ctx, f.users.admin, source.id, f.projectA);
    }
    return original(statements);
  };
  const response = await f.save(turn, a.revision, {
    version: 1,
    blocks: [
      {
        type: "table",
        fileId: source.id,
        pointer: "",
        columns: [{ label: "Value", key: "value" }],
      },
    ],
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(
    (await f.request("full", "GET", `/enterprise/api/assets/${a.id}`)).json()
      .revision,
    a.revision,
  );
  await f.conversations.recheckAccess();
  assert.ok(f.stops.includes(c.id));
});

test("failed idle cleanup stays retryable without starving other assets; a stale completion cannot mark a newly admitted lease idle", async (t) => {
  const f = await fixture(t),
    a = await f.create(),
    b = await f.create(),
    ac = await f.conversation(a.id),
    bc = await f.conversation(b.id);
  const at = await f.prompt(ac.id),
    bt = await f.prompt(bc.id);
  await f.complete(at);
  await f.complete(bt);
  await f.db.run("UPDATE asset_workspaces SET last_activity=0");
  const release = f.runtime.releaseAsset!;
  let fail = true;
  f.runtime.releaseAsset = async (spec) => {
    if (spec.owner!.assetId === a.id && fail)
      throw new Error("fixture supervisor unavailable");
    await release(spec);
  };
  await assert.rejects(f.assetAgents.maintenance(), {
    code: "asset_cleanup_pending",
  });
  assert.equal(
    (await f.assetAgents.detail(f.users.admin, a.id)).state,
    "releasing",
  );
  assert.equal((await f.assetAgents.detail(f.users.admin, b.id)).state, "idle");
  fail = false;
  await f.assetAgents.maintenance();
  assert.equal((await f.assetAgents.detail(f.users.admin, a.id)).state, "idle");
  const next = await f.prompt(ac.id);
  await f.complete(next);
  await f.db.run(
    "UPDATE asset_workspaces SET last_activity=0 WHERE asset_id=?",
    [a.id],
  );
  let admitted: Awaited<ReturnType<typeof f.prompt>> | undefined;
  f.runtime.releaseAsset = async (spec) => {
    if (spec.owner!.assetId === a.id) {
      admitted = await f.prompt(ac.id);
      assert.ok(admitted.request.workspaceLease! > spec.workspaceLease!);
    }
    await release(spec);
  };
  await f.assetAgents.maintenance();
  assert.equal(
    (await f.assetAgents.detail(f.users.admin, a.id)).state,
    "ready",
  );
  await f.complete(admitted!);
});

test("admin editing after creator revocation uses current draft authority without borrowing creator access", async (t) => {
  const f = await fixture(t),
    a = await f.create(f.projectA, "full"),
    c = await f.conversation(a.id, "admin");
  await f.db.run("UPDATE users SET enabled=0 WHERE id=?", [f.users.full.id]);
  const turn = await f.prompt(c.id, "admin");
  assert.equal(
    (await f.save(turn, a.revision, document("Current editor authority")))
      .statusCode,
    200,
  );
  const preview = await f.request("admin", "GET", a.url + "/preview");
  assert.equal(preview.statusCode, 200, preview.body);
  assert.match(preview.body, /Current editor authority/);
  // Published-source policy remains creator-based until deliberately re-owned.
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/assets/${a.id}/publish`,
        { expectedRevision: a.revision + 1, visibility: "public" },
      )
    ).statusCode,
    404,
  );
  await f.complete(turn);
});

test("deleting an unopened asset needs no compute; project trash restores asset drafts and purge removes generated snapshots without FK leaks", async (t) => {
  const f = await fixture(t),
    unopened = await f.create();
  await f.conversation(unopened.id);
  assert.equal(
    (
      await f.request(
        "admin",
        "DELETE",
        `/enterprise/api/assets/${unopened.id}`,
      )
    ).statusCode,
    200,
  );
  assert.equal(f.ensured.length, 0);
  f.runtime.stopProject = async () => {};
  f.runtime.restoreProject = async () => {};
  f.runtime.purgeProject = async () => {};
  const a = await f.create(f.projectA, "full"),
    c = await f.conversation(a.id, "full"),
    turn = await f.prompt(c.id, "full");
  await writeFile(
    join(turn.request.mounts[0].source, "retained.json"),
    '[{"value":19}]',
  );
  const saved = await f.save(turn, a.revision, {
    version: 1,
    blocks: [
      {
        type: "table",
        fileId: "workspace:retained.json",
        pointer: "",
        columns: [{ label: "Value", key: "value" }],
      },
    ],
  });
  assert.equal(saved.statusCode, 200, saved.body);
  await f.complete(turn);
  assert.equal(
    (
      await f.request(
        "admin",
        "DELETE",
        `/enterprise/api/projects/${f.projectA}`,
      )
    ).statusCode,
    202,
  );
  assert.equal(
    (await f.request("full", "GET", a.url + "/preview")).statusCode,
    404,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "POST",
        `/enterprise/api/deleted-projects/${f.projectA}/restore`,
        {},
      )
    ).statusCode,
    200,
  );
  assert.match(
    (await f.request("full", "GET", a.url + "/preview")).body,
    />19</,
  );
  assert.equal(
    (
      await f.request(
        "admin",
        "DELETE",
        `/enterprise/api/projects/${f.projectA}`,
      )
    ).statusCode,
    202,
  );
  await f.db.run("UPDATE projects SET purge_after='2000-01-01' WHERE id=?", [
    f.projectA,
  ]);
  assert.equal(await purgeExpiredProject(f.ctx, f.projectA), true);
  assert.deepEqual(await f.db.all("PRAGMA foreign_key_check"), []);
  assert.equal(
    (await f.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM asset_output_versions",
    ))!.n,
    0,
  );
  assert.equal(
    (await f.db.get<{ n: number }>("SELECT COUNT(*) n FROM asset_agent_saves"))!
      .n,
    0,
  );
  assert.equal(
    (await f.db.get<{ asset_id: string | null }>(
      "SELECT asset_id FROM conversations WHERE id=?",
      [c.id],
    ))!.asset_id,
    null,
  );
});
