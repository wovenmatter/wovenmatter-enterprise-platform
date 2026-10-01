export const DOCUMENT_PREVIEW_BYTES = 20 * 1024 * 1024;
export const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export type PreviewKind = "pdf" | "image" | "text" | "unsupported";
const rasterTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};
const textExtensions = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "sql",
  "py",
  "rs",
  "go",
  "sh",
]);
export function previewType(filename: string): {
  kind: PreviewKind;
  mimeType?: string;
  limit: number;
} {
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension === "pdf")
    return {
      kind: "pdf",
      mimeType: "application/pdf",
      limit: DOCUMENT_PREVIEW_BYTES,
    };
  if (rasterTypes[extension])
    return {
      kind: "image",
      mimeType: rasterTypes[extension],
      limit: DOCUMENT_PREVIEW_BYTES,
    };
  if (textExtensions.has(extension))
    return { kind: "text", mimeType: "text/plain", limit: TEXT_PREVIEW_BYTES };
  return { kind: "unsupported", limit: 0 };
}
export function filenameFromDisposition(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition?.match(/filename\s*=\s*"((?:\\.|[^"\\])*)"/i)?.[1];
  const plain = disposition?.match(/filename\s*=\s*([^;]+)/i)?.[1];
  let filename = quoted?.replace(/\\(.)/g, "$1") ?? plain?.trim() ?? "Document";
  if (encoded) {
    try {
      filename = decodeURIComponent(encoded.trim());
    } catch {
      /* Use the safe fallback filename. */
    }
  }
  return (
    filename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "Document"
  );
}
export class PreviewTooLarge extends Error {}
export async function boundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel();
    throw new PreviewTooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new PreviewTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function sourcePath(
  fileId: string,
  options: {
    projectId?: string | null;
    versionId?: string | null;
    page?: number;
  } = {},
): string {
  const query = new URLSearchParams();
  if (options.projectId) query.set("projectId", options.projectId);
  if (options.versionId) query.set("versionId", options.versionId);
  if (options.page && Number.isSafeInteger(options.page) && options.page > 0)
    query.set("page", String(options.page));
  return `/source/${encodeURIComponent(fileId)}${query.size ? `?${query}` : ""}`;
}
export function sourcePathFromContentUrl(
  url: string,
  page?: number,
): string | undefined {
  try {
    const parsed = new URL(url, "https://preview.invalid");
    if (parsed.origin !== "https://preview.invalid") return;
    const match = parsed.pathname.match(/^\/api\/files\/([^/]+)\/content$/);
    if (!match) return;
    return sourcePath(decodeURIComponent(match[1]), {
      projectId: parsed.searchParams.get("projectId"),
      versionId: parsed.searchParams.get("versionId"),
      page,
    });
  } catch {
    return;
  }
}
