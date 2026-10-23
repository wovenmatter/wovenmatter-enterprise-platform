import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDirectory } from "./sandbox.js";
import { RuntimeError, type RuntimeAttachment } from "./types.js";

// WovenMatter MessageAttachments.swift:295–299 at f885d2818f9cc380612bd1f4cf32176d3c99dd5e.
export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
// Base64 plus bounded text/envelope overhead. Output protocol limits stay small.
export const MAX_INPUT_BYTES = 72 * 1024 * 1024;
const invalid = () => new RuntimeError("invalid_attachment", "The message attachment is invalid or exceeds its limit.");

export function validateAttachments(value: unknown): asserts value is RuntimeAttachment[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) throw invalid();
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some(key => !["name", "mimeType", "data"].includes(key)) ||
      typeof item.name !== "string" || !item.name.trim() || Buffer.byteLength(item.name) > 255 || /[\x00-\x1f\x7f]/.test(item.name) ||
      typeof item.mimeType !== "string" || item.mimeType.length > 160 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(item.mimeType) ||
      typeof item.data !== "string" || item.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
      item.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.data)) throw invalid();
    const bytes = Buffer.from(item.data, "base64");
    if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString("base64") !== item.data) throw invalid();
    total += bytes.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw invalid();
  }
}

type PreparedAttachment = RuntimeAttachment & { path: string; uri: string; size: number; text?: string };

/** Content-addressed copies live in this thread's private session, never shared files.
 * Held directory descriptors and no-follow opens reject symlink/hardlink escapes.
 * Changed ordinary copies are repaired atomically from authoritative snapshot bytes.
 */
export async function prepareAttachments(value: RuntimeAttachment[] | undefined, sessionDirectory: string): Promise<PreparedAttachment[]> {
  validateAttachments(value);
  const prepared: PreparedAttachment[] = [];
  for (const item of value ?? []) {
    const bytes = Buffer.from(item.data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const clean = item.name.replace(/[\\/:]/g, "_");
    const name = [".", ".."].includes(clean) ? "attachment" : clean;
    const directory = await openDirectory(sessionDirectory, "attachments/" + hash, true);
    const held = `/proc/self/fd/${directory.fd}`;
    const path = join(sessionDirectory, "attachments", hash, name);
    let temporary: string | undefined;
    try {
      let matches = false;
      try {
        const existing = await open(join(held, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await existing.stat();
          if (!stat.isFile() || stat.nlink !== 1) throw invalid();
          if (stat.size === bytes.length) matches = (await existing.readFile()).equals(bytes);
        } finally { await existing.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!matches) {
        temporary = join(held, ".part-" + randomUUID());
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); } finally { await file.close(); }
        await rename(temporary, join(held, name));
        temporary = undefined;
      }
      let text: string | undefined;
      if (item.mimeType.startsWith("text/")) {
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* Binary fallback matches desktop. */ }
      }
      prepared.push({ ...item, path, uri: pathToFileURL(path).href, size: bytes.length, ...(text === undefined ? {} : { text }) });
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await directory.close();
    }
  }
  return prepared;
}

/** Desktop LocalACPClient.promptBlocks: image bytes, UTF-8 resources, binary links. */
export function attachmentPrompt(text: string, files: PreparedAttachment[]) {
  const linked = files.filter(file => !file.mimeType.startsWith("image/") && file.text === undefined);
  const content = text + (linked.length ? "\n\nAttached files available to this session:\n" + linked.map(file => "- " + file.path).join("\n") : "");
  return [
    ...(content ? [{ type: "text", text: content }] : []),
    ...files.map(file => file.mimeType.startsWith("image/")
      ? { type: "image", mimeType: file.mimeType, data: file.data }
      : file.text !== undefined
        ? { type: "resource", resource: { uri: file.uri, mimeType: file.mimeType, text: file.text } }
        : { type: "resource_link", uri: file.uri, name: file.name, mimeType: file.mimeType, size: file.size }),
  ];
}

export const openCodeFiles = (files: PreparedAttachment[]) => files.map(file => ({
  uri: `data:${file.mimeType};base64,${file.data}`, name: file.name,
}));

/** Desktop Pi Durable's ACP boundary is text-only. Preserve the uploaded bytes
 * for its existing native read/document tools instead of silently dropping them.
 * This is an Enterprise transport adaptation, not direct image prompt support.
 */
export function attachmentToolText(text: string, files: PreparedAttachment[]) {
  return text + (files.length ? "\n\nAttached files available to this session (use native file tools to inspect them):\n" +
    files.map(file => `- ${JSON.stringify(file.name)} (${file.mimeType}): ${file.path}`).join("\n") : "");
}
