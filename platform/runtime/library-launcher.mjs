// Trusted image code. Never copy this into the writable or generated application tree.
import { lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const entrypoint = process.env.WME_LIBRARY_ENTRYPOINT;
const encoded = process.env.WME_LIBRARY_MOUNTS;
delete process.env.WME_LIBRARY_ENTRYPOINT;
delete process.env.WME_LIBRARY_MOUNTS;
if (
  !entrypoint ||
  !encoded ||
  encoded.length > 65536 ||
  entrypoint.startsWith("/") ||
  !/[.](?:js|mjs|cjs)$/.test(entrypoint) ||
  entrypoint.split("/").some((p) => !p || p === ".." || p.startsWith(".")) ||
  /[\\\x00-\x1f]/.test(entrypoint)
)
  throw new Error("Invalid library startup manifest");
const evidence = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
if (!Array.isArray(evidence) || evidence.length < 2 || evidence.length > 32)
  throw new Error("Invalid library mount manifest");
const seen = new Set();
for (const item of evidence) {
  if (
    !item ||
    typeof item.target !== "string" ||
    (!["/app", "/data"].includes(item.target) &&
      !/^\/sources\/[a-zA-Z0-9_-]+$/.test(item.target)) ||
    seen.has(item.target) ||
    typeof item.device !== "string" ||
    typeof item.inode !== "string" ||
    item.kind !== "directory"
  )
    throw new Error("Invalid library mount evidence");
  seen.add(item.target);
  const stat = await lstat(item.target, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev.toString() !== item.device ||
    stat.ino.toString() !== item.inode
  )
    throw new Error("Library mount identity changed");
}
if (!seen.has("/app") || !seen.has("/data"))
  throw new Error("Required library mounts are missing");
await import(pathToFileURL(`/app/${entrypoint}`).href);
