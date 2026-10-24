import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformFixture } from "./fixtures/platform.js";
import { createDatabase, type Database } from "../apps/api/src/db/index.js";
import { createContext } from "../apps/api/src/context.js";
import { createConversationService, type ConversationService } from "../apps/api/src/conversations/index.js";
import { scopeRoot } from "../apps/api/src/files/paths.js";
import { validateContainerRequest } from "../packages/runtime/src/validation.js";
import type { Harness, Runtime, RuntimeRequest } from "../packages/runtime/src/types.js";

const harnesses: Harness[] = ["claude_code", "codex", "opencode", "pi", "grok_build"];

// This fixture exercises the real API, persistence and dispatch mapping. Native
// adapter cwd and container namespace isolation have separate runtime tests.
async function fixture(t: TestContext) {
  const requests: RuntimeRequest[] = [];
  const failures = new Set<string>();
  const runtime: Runtime = {
    async recover() { return []; },
    async cancel() {},
    async execute(input, emit) {
      validateContainerRequest(input);
      requests.push(input);
      await emit({ type: "started" });
      await emit({ type: "input_accepted" });
      await emit({ type: "native_session", sessionId: "fixture-" + input.conversationId });
      await emit(failures.has(input.conversationId)
        ? { type: "failed", code: "fixture_failure", message: "Deterministic failure after acceptance" }
        : { type: "completed" });
    },
  };
  const f = await platformFixture(t, { runtime });
  f.inference.models = async () => [{ id: "fixture-model", provider: "openai", name: "Fixture" }];
  f.inference.validateSelection = async () => {};
  f.inference.issueGateway = async () => ({ baseUrl: "http://gateway.invalid/inference", token: "synthetic-fixture-capability" });
  f.inference.revokeGateway = async () => {};
  const user = f.users.full!;
  const root = scopeRoot(f.ctx, { orgId: f.orgA, projectId: f.projectA });
  const create = (harness: Harness, extra: Record<string, unknown> = {}) =>
    f.conversations.create(user, f.projectA, { harness, model: "fixture-model", ...extra });
  const folder = async (name: string) => {
    const response = await f.request("full", "POST", `/enterprise/api/projects/${f.projectA}/folders`, { name });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string; rootPath: string };
  };
  return { ...f, root, user, create, folder, requests, failures };
}

async function send(db: Database, service: ConversationService, user: Awaited<ReturnType<typeof fixture>>["user"], id: string, content: string) {
  const receipt = await service.admit(user, id, { content, requestId: randomUUID() });
  assert.ok(receipt.run);
  for (let attempt = 0; attempt < 500; attempt++) {
    const run = await db.get<{ status: string; error_code: string | null }>("SELECT status,error_code FROM conversation_runs WHERE id=?", [receipt.run.id]);
    if (run && ["completed", "failed", "interrupted", "cancelled"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Fixture dispatch did not reach a terminal state");
}

for (const harness of harnesses) {
  test(`${harness}: named roots are shared, scratch roots are distinct, and restart resumes the saved binding`, async t => {
    const f = await fixture(t);
    const folder = await f.folder("Shared root");
    assert.deepEqual(await readdir(join(f.root, folder.rootPath)), []);
    const named = await f.create(harness, { folderId: folder.id });
    const sibling = await f.create(harness, { folderId: folder.id });
    const scratch = await f.create(harness);
    const otherScratch = await f.create(harness);
    assert.equal(named.workspaceLocked, false);
    assert.equal(named.mode, "write");
    for (const chat of [named, sibling, scratch, otherScratch])
      assert.equal((await send(f.db, f.conversations, f.user, chat.id, "Inspect the workspace")).status, "completed");
    const cwd = (id: string) => f.requests.find(request => request.conversationId === id)!.workingDirectory;
    assert.equal(cwd(named.id), "/workspace/" + folder.rootPath);
    assert.equal(cwd(sibling.id), cwd(named.id));
    assert.match(cwd(scratch.id), /^\/workspace\/\.WovenMatter\/scratch\/\d{4}-\d{2}-\d{2}-inspect-the-workspace-[a-z0-9]+$/);
    assert.notEqual(cwd(otherScratch.id), cwd(scratch.id));
    assert.deepEqual(await readdir(join(f.root, cwd(scratch.id).slice("/workspace/".length))), []);
    assert.deepEqual(await readdir(join(f.root, cwd(otherScratch.id).slice("/workspace/".length))), []);
    for (const request of f.requests) {
      assert.equal(request.harness, harness);
      assert.equal(request.mounts.find(mount => mount.target === "/workspace")?.source, f.root);
      assert.ok(!request.sessionDirectory.startsWith(f.root + "/"), "Native history must remain outside shared files");
    }
    const savedPath = cwd(scratch.id);
    const file = join(f.root, savedPath.slice("/workspace/".length), "result.txt");
    await writeFile(file, "Preserved across rename and restart");
    await f.conversations.organize(f.user, scratch.id, { title: "Renamed after acceptance" });
    const renamed = await f.request("full", "PATCH", `/enterprise/api/projects/${f.projectA}/folders/${folder.id}`, { name: "Display name only" });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().rootPath, folder.rootPath);
    await assert.rejects(f.conversations.organize(f.user, scratch.id, { folderId: folder.id }), { code: "fixed_workspace" });

    await f.conversations.close();
    const db = await createDatabase(join(f.stateDir, "control", "platform.sqlite"));
    const resumed = await createConversationService(createContext(db, f.ctx.config), f.conversations.dependencies);
    try {
      await resumed.start();
      assert.equal((await resumed.get(f.user, scratch.id)).workingDirectory, savedPath);
      assert.equal((await send(db, resumed, f.user, scratch.id, "Continue after restart")).status, "completed");
      const next = f.requests.at(-1)!;
      assert.equal(next.workingDirectory, savedPath);
      assert.equal(next.resumeId, "fixture-" + scratch.id);
      assert.equal(await readFile(file, "utf8"), "Preserved across rename and restart");
      await resumed.remove(f.user, scratch.id);
      assert.equal(await readFile(file, "utf8"), "Preserved across rename and restart");
    } finally {
      await resumed.close();
      await db.close();
    }
  });

  test(`${harness}: rejected admission preserves editable scratch reservation; accepted failure keeps its root locked`, async t => {
    const f = await fixture(t);
    const folder = await f.folder("Chosen before retry");
    const chat = await f.create(harness);
    const batch = f.db.batch.bind(f.db);
    let rejectAdmission = true;
    f.db.batch = async statements => {
      if (rejectAdmission && statements.some(statement => statement.sql.startsWith("INSERT INTO conversation_inputs"))) {
        rejectAdmission = false;
        throw new Error("Synthetic pre-admission storage failure");
      }
      return batch(statements);
    };
    await assert.rejects(f.conversations.admit(f.user, chat.id, { content: "First attempted wording", requestId: randomUUID() }), /Synthetic pre-admission/);
    const reserved = await f.conversations.get(f.user, chat.id);
    assert.equal(reserved.workspaceLocked, false);
    assert.match(reserved.workingDirectory!, /first-attempted-wording-/);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.conversations.messages(f.user, chat.id)).items.length, 0);
    const directory = join(f.root, reserved.workingDirectory!.slice("/workspace/".length));
    await writeFile(join(directory, "before-retry.txt"), "Keep reservation contents");
    const selected = await f.conversations.organize(f.user, chat.id, { folderId: folder.id, title: "Changed draft" });
    assert.equal(selected.folderId, folder.id);
    assert.equal(selected.workspaceLocked, false);
    await f.conversations.organize(f.user, chat.id, { folderId: null });
    f.failures.add(chat.id);
    assert.equal((await send(f.db, f.conversations, f.user, chat.id, "Different retry wording")).status, "failed");
    const failed = await f.conversations.get(f.user, chat.id);
    assert.equal(failed.workingDirectory, reserved.workingDirectory);
    assert.equal(failed.workspaceLocked, true);
    assert.equal(f.requests[0].workingDirectory, reserved.workingDirectory);
    assert.equal(await readFile(join(directory, "before-retry.txt"), "utf8"), "Keep reservation contents");
    await assert.rejects(f.conversations.organize(f.user, chat.id, { folderId: folder.id }), { code: "fixed_workspace" });
    f.failures.delete(chat.id);
    assert.equal((await send(f.db, f.conversations, f.user, chat.id, "Explicit retry after failed turn")).status, "completed");
    assert.equal(f.requests.at(-1)!.workingDirectory, reserved.workingDirectory);
  });
}

test("all five engines reject cross-project and substituted roots without dispatching or touching host files", async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "wme-folder-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "private.txt"), "Host fixture must remain untouched");
  const foreign = await f.request("other", "POST", `/enterprise/api/projects/${f.projectB}/folders`, { name: "Foreign root" });
  assert.equal(foreign.statusCode, 201, foreign.body);
  for (const harness of harnesses) {
    await assert.rejects(f.create(harness, { folderId: foreign.json().id }), { code: "workspace_unavailable" });
    const folder = await f.folder("Root " + harness);
    const chat = await f.create(harness, { folderId: folder.id, workingDirectory: outside });
    const root = join(f.root, folder.rootPath);
    await rename(root, root + "-original");
    await symlink(outside, root);
    await assert.rejects(f.conversations.admit(f.user, chat.id, { content: "Must reject symlink", requestId: randomUUID() }));
    assert.equal((await f.conversations.get(f.user, chat.id)).workspaceLocked, false);
    assert.equal((await f.conversations.messages(f.user, chat.id)).items.length, 0);
    await rm(root);
    await mkdir(root);
    await assert.rejects(f.conversations.admit(f.user, chat.id, { content: "Must reject replacement inode", requestId: randomUUID() }), { code: "workspace_unavailable" });
    assert.equal(f.requests.length, 0);
    for (const path of ["/etc", "/workspace/../host", "/workspace/.WovenMatter/../../host", "/workspace/.WovenMatter/scratch/../../host"]) {
      assert.throws(() => validateContainerRequest({ runId: "fixture-run", projectId: "fixture-project", harness,
        model: "fixture-model", prompt: "hello", access: "write", workingDirectory: path,
        gateway: { baseUrl: "http://gateway.invalid", token: "synthetic-fixture-capability" } }), { code: "invalid_working_directory" });
    }
  }
  assert.equal(await readFile(join(outside, "private.txt"), "utf8"), "Host fixture must remain untouched");
  assert.deepEqual(await readdir(outside), ["private.txt"]);
});
