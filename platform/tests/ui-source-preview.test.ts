import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedBytes,
  filenameFromDisposition,
  PreviewTooLarge,
  previewType,
  sourcePath,
  sourcePathFromContentUrl,
} from "../apps/web/src/source-preview.js";

test("raw HTML and SVG are text sources while office files remain downloads", () => {
  assert.equal(previewType("evidence.HTML").kind, "text");
  assert.equal(previewType("untrusted.svg").kind, "text");
  assert.equal(previewType("brief.docx").kind, "unsupported");
  assert.equal(previewType("model.xlsx").kind, "unsupported");
  assert.deepEqual(previewType("scan.PDF"), {
    kind: "pdf",
    mimeType: "application/pdf",
    limit: 20 * 1024 * 1024,
  });
  assert.equal(previewType("photo.png").mimeType, "image/png");
});
test("download filename parsing supports UTF-8 and safely falls back on malformed values", () => {
  assert.equal(
    filenameFromDisposition(
      "attachment; filename=\"fallback.txt\"; filename*=UTF-8''Case%20%C3%A9.txt",
    ),
    "Case é.txt",
  );
  assert.equal(
    filenameFromDisposition('attachment; filename="report.html"'),
    "report.html",
  );
  assert.equal(
    filenameFromDisposition(
      "attachment; filename=\"fallback.txt\"; filename*=UTF-8''bad%ZZ",
    ),
    "fallback.txt",
  );
  assert.equal(filenameFromDisposition(null), "Document");
});
test("preview reads reject oversized streamed content even without Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
      controller.enqueue(new Uint8Array(3));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(boundedBytes(new Response(body), 5), PreviewTooLarge);
  assert.equal(cancelled, true);
  const bytes = await boundedBytes(new Response("small"), 5);
  assert.equal(new TextDecoder().decode(bytes), "small");
});
test("historical citation routing preserves exact version, project authorization context, and page", () => {
  assert.equal(
    sourcePathFromContentUrl(
      "/enterprise/api/files/file-a/content?projectId=project-b&versionId=revision-c",
      7,
    ),
    "/source/file-a?projectId=project-b&versionId=revision-c&page=7",
  );
  assert.equal(sourcePath("a/b", { page: -1 }), "/source/a%2Fb");
  assert.equal(
    sourcePathFromContentUrl("https://other.example/api/files/a/content"),
    undefined,
  );
  assert.equal(
    sourcePathFromContentUrl("//other.example/api/files/a/content"),
    undefined,
  );
  assert.equal(sourcePathFromContentUrl("/enterprise/api/login"), undefined);
});
