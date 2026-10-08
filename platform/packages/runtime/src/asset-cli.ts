#!/usr/bin/env node
/** Private run-scoped draft operation. This command cannot publish or select another asset. */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const [operation, path] = process.argv.slice(2);
try {
  if (
    !["context", "save"].includes(operation ?? "") ||
    (operation === "save" && !path)
  )
    throw new Error("Use wme-asset context or wme-asset save FILE.json");
  const grant = JSON.parse(await readFile("/session/.wme-asset.json", "utf8"));
  if (
    grant.baseUrl !== "http://127.0.0.1:4101/inference" ||
    typeof grant.token !== "string"
  )
    throw new Error("Asset work is unavailable in this conversation.");
  let body: Record<string, unknown> = { operation };
  if (operation === "save") {
    const raw = await readFile(path!);
    if (raw.length > 256 * 1024)
      throw new Error("The draft exceeds the supported size.");
    const value = JSON.parse(raw.toString());
    body = {
      operation,
      operationId: randomUUID(),
      expectedRevision: value.expectedRevision,
      document: value.document,
    };
  }
  const response = await fetch(grant.baseUrl + "/asset", {
    method: "POST",
    headers: {
      authorization: "Bearer " + grant.token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      String(
        value.error?.message ??
          value.message ??
          "Draft operation failed. Read current context before retrying.",
      ),
    );
  process.stdout.write(JSON.stringify(value) + "\n");
} catch (error) {
  console.error(
    error instanceof Error && error.name === "TimeoutError"
      ? "Save outcome is uncertain. Read current context before making further changes."
      : error instanceof Error
        ? error.message
        : "Asset operation failed.",
  );
  process.exitCode = 1;
}
