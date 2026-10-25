#!/usr/bin/env node
/** Shared workspace tools through the private current-run broker. */
import { readFile } from "node:fs/promises";
const [operation, filename] = process.argv.slice(2);
try {
  if (!["list", "read", "create", "update", "delete", "versions", "restore", "library", "usage", "databases"].includes(operation ?? ""))
    throw new Error("Use wme-workspace list|read|create|update|delete|versions|restore|library|usage|databases [REQUEST.json]");
  const grant = JSON.parse(await readFile("/session/.wme-workspace.json", "utf8"));
  if (grant.baseUrl !== "http://127.0.0.1:4101/inference" || typeof grant.token !== "string")
    throw new Error("Workspace tools are unavailable in this conversation.");
  let body = {};
  if (filename) {
    const bytes = await readFile(filename);
    if (bytes.length > 2 * 1024 * 1024) throw new Error("The request exceeds 2 MiB.");
    body = JSON.parse(bytes.toString());
  }
  const response = await fetch(grant.baseUrl + "/workspace/" + operation, {
    method: "POST", headers: { authorization: "Bearer " + grant.token, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(String(result.error?.message ?? "Workspace operation failed. Read current state before retrying."));
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  console.error(error instanceof Error && ["TimeoutError", "AbortError", "TypeError"].includes(error.name)
    ? "The operation outcome is uncertain. Read current workspace state before making further changes."
    : error instanceof Error ? error.message : "Workspace operation failed.");
  process.exitCode = 1;
}
