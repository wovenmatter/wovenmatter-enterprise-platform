import test from "node:test";
import assert from "node:assert/strict";
import {
  coalescedReader,
  emptyAssistantLabel,
  clearPendingMessage,
  loadPendingMessage,
  mergeMessages,
  safeContentUrl,
  savePendingMessage,
} from "../apps/web/src/conversation-state.js";

test("continuous stream events coalesce behind a slow read without aborting it", async () => {
  const completions: (() => void)[] = [];
  let reads = 0;
  let active = 0;
  let maximumActive = 0;
  const reader = coalescedReader(async () => {
    reads++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => completions.push(resolve));
    active--;
  });
  reader.trigger();
  for (let event = 0; event < 100; event++) reader.trigger();
  assert.equal(reads, 1);
  completions.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(maximumActive, 1);
  completions.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  reader.dispose();
  reader.trigger();
  assert.equal(reads, 2);
});

test("a rolling 200 message page retains earlier displayed history and canonical revisions", () => {
  const initial = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    createdAt: new Date(i * 1000).toISOString(),
    content: `message ${i}`,
  }));
  const latest = Array.from({ length: 200 }, (_, i) => ({
    id: String(i + 50),
    createdAt: new Date((i + 50) * 1000).toISOString(),
    content: `updated ${i + 50}`,
  }));
  const merged = mergeMessages(initial, latest);
  assert.equal(merged.length, 250);
  assert.equal(merged[0].id, "0");
  assert.equal(merged[50].content, "updated 50");
  assert.equal(merged.at(-1)?.id, "249");
  assert.deepEqual(mergeMessages(merged, latest), merged);
});

test("empty terminal assistant records never claim the agent is still working", () => {
  for (const status of [
    "failed",
    "cancelled",
    "completed",
    "interrupted",
    undefined,
  ])
    assert.equal(emptyAssistantLabel(status), "No response generated.");
  assert.equal(emptyAssistantLabel("queued"), "Queued");
  assert.equal(emptyAssistantLabel("running"), "Working…");
  assert.equal(emptyAssistantLabel("cancelling"), "Stopping…");
});

test("uncertain submission survives reload with the same identity and is scoped to user and conversation", () => {
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
    removeItem: (key: string) => {
      records.delete(key);
    },
  };
  const key = "wme:pending:user-a:conversation-a";
  const pending = {
    id: "admissible-request-identity",
    content: "Review the attached material.",
  };
  savePendingMessage(key, pending, storage);
  assert.deepEqual(loadPendingMessage(key, storage), pending);
  assert.equal(
    loadPendingMessage("wme:pending:user-b:conversation-a", storage),
    undefined,
  );
  clearPendingMessage(key, storage);
  assert.equal(loadPendingMessage(key, storage), undefined);
  storage.setItem(key, '{"id":"<script>","content":null}');
  assert.equal(loadPendingMessage(key, storage), undefined);
});
test("untrusted Markdown blocks executable and scheme-relative destinations while retaining protected source URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<h1>Hi</h1>",
    "//tracker.example",
    "/\\evil.example",
    "java\nscript:alert(1)",
    "file:///etc/passwd",
  ])
    assert.equal(safeContentUrl(url), undefined, url);
  assert.equal(
    safeContentUrl("/api/files/source/content?versionId=version"),
    "/api/files/source/content?versionId=version",
  );
  assert.equal(
    safeContentUrl("https://example.com/report"),
    "https://example.com/report",
  );
});
