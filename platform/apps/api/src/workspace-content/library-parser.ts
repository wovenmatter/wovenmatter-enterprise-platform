// Port: WovenMatter 04fe05090e107df92c498a4563b742978c91d933,
// WorkspaceLibrary.swift LibraryLinkDiscovery / LibraryFileReference.
export interface LibraryAsset { source: string; title: string; type: "link" | "file" | "photo" }
const photos = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i;
const files = /\.(pdf|docx?|xlsx?|csv|pptx?|zip|txt|md|rtf|json|mp3|mp4|mov|wav)$/i;
export function libraryKind(source: string): LibraryAsset["type"] {
  const path = source.split(/[?#]/, 1)[0]!;
  return photos.test(path) ? "photo" : !/^https?:/i.test(source) || files.test(path) ? "file" : "link";
}
export function discoverLibraryAssets(content: string): LibraryAsset[] {
  const source = content.slice(0, 1_000_000).replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const result: LibraryAsset[] = [], seen = new Set<string>(), spans: [number, number][] = [];
  function append(raw: string, title?: string) {
    raw = raw.replace(/^<|>$/g, "");
    if (!raw || Buffer.byteLength(raw) > 8192 || /[\r\n\0]/.test(raw) || result.length >= 200 || seen.has(raw)) return;
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
    if (scheme && !["http", "https", "file", "sandbox"].includes(scheme)) return;
    if (!scheme && !raw.includes("/") && !/\.[^./]+$/.test(raw)) return;
    let fallback = raw.split(/[?#]/, 1)[0]!.split("/").at(-1) || raw;
    if (scheme === "http" || scheme === "https") {
      try { const url = new URL(raw); if (url.username || url.password) return; fallback = url.pathname.split("/").at(-1) || url.hostname; } catch { return; }
    }
    try { fallback = decodeURIComponent(fallback); } catch { /* Keep the supplied label. */ }
    seen.add(raw);
    result.push({ source: raw, title: (title?.trim() || fallback).slice(0, 512), type: libraryKind(raw) });
  }
  for (const match of source.matchAll(/!?\[([^\[\]\n]*)\]\((<[^>\n]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+"[^"]*")?\)/g)) {
    append(match[2]!, match[1]); spans.push([match.index!, match.index! + match[0].length]);
    if (result.length === 200) return result;
  }
  for (const match of source.matchAll(/^[ \t]*\[[^\[\]\r\n]+\]:[ \t]*(\S+)/gm)) append(match[1]!);
  let index = 0;
  for (const match of source.matchAll(/\b(?:https?:\/\/|file:\/\/\/|sandbox:\/)[^\s<>\[\]"']+/gi)) {
    while (index < spans.length && spans[index]![1] <= match.index!) index++;
    if (index < spans.length && spans[index]![0] < match.index! + match[0].length) continue;
    let raw = match[0].replace(/[.,;!?]+$/, "");
    let extra = [...raw].reduce((n, ch) => n + (ch === ")" ? 1 : ch === "(" ? -1 : 0), 0);
    while (raw.endsWith(")") && extra-- > 0) raw = raw.slice(0, -1);
    append(raw);
  }
  for (const match of source.matchAll(/(?:^|\s)MEDIA:\s*([^\s]+)/gm)) append(match[1]!);
  return result;
}
/** Decode once. Never normalize away traversal before validating it. */
export function libraryFilePath(source: string): string {
  if (/[\x00-\x1f\x7f\\]/.test(source)) throw new Error("invalid_reference");
  let path = source;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(source)?.[1];
  if (scheme) {
    if (!["file", "sandbox"].includes(scheme.toLowerCase())) throw new Error("invalid_reference");
    const match = /^(?:file|sandbox):(?:(?:\/\/)([^/]*))?(\/[^?#]*)(?:[?#].*)?$/i.exec(source);
    if (!match || (match[1] && match[1] !== "localhost")) throw new Error("invalid_reference");
    path = match[2]!;
  } else path = source.split(/[?#]/, 1)[0]!;
  path = decodeURIComponent(path);
  if (!path || /[\x00-\x1f\x7f\\]/.test(path) || path.split("/").some(p => p === "..")) throw new Error("invalid_reference");
  return path;
}
