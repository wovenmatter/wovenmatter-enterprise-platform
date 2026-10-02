import type { FastifyReply } from "fastify";
import {
  AppError,
  mapUser,
  objectBody,
  stringValue,
  type AppContext,
  type User,
} from "../context.js";
import { authorizeFile } from "../files/index.js";
import { readCurrentFile } from "../files/service.js";
type Column = {
  label: string;
  key: string;
};
export type Block =
  | {
      type: "heading";
      text: string;
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "details";
      title: string;
      text: string;
    }
  | {
      type: "image";
      fileId: string;
      alt: string;
    }
  | {
      type: "table";
      fileId: string;
      pointer: string;
      columns: Column[];
    }
  | {
      type: "bars";
      fileId: string;
      pointer: string;
      labelKey: string;
      valueKey: string;
      title: string;
    };
export type Report = {
  version: 1;
  blocks: Block[];
};
type Visibility = "project" | "organization" | "public";
export type Asset = {
  id: string;
  org_id: string;
  project_id: string | null;
  creator_id: string;
  name: string;
  visibility: Visibility;
  document: string;
  created_at: string;
  updated_at: string;
};
const fail = () =>
  new AppError(
    400,
    "invalid_report",
    "Use a version 1 report with supported text, table, image, or chart blocks.",
  );
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k))) throw fail();
}
function text(value: unknown, max = 4000) {
  return stringValue(value, "report text", max, true);
}
function key(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw fail();
  return value;
}
function pointer(value: unknown) {
  if (value === undefined || value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^\/(?:[a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)*$/.test(value)
  )
    throw fail();
  value.slice(1).split("/").forEach(key);
  return value;
}
export function validateReport(input: unknown): Report {
  const value = objectBody(input);
  exact(value, ["version", "blocks"]);
  if (
    value.version !== 1 ||
    !Array.isArray(value.blocks) ||
    value.blocks.length < 1 ||
    value.blocks.length > 100 ||
    Buffer.byteLength(JSON.stringify(value)) > 256 * 1024
  )
    throw fail();
  const blocks: Block[] = value.blocks.map((raw) => {
    const b = objectBody(raw);
    if (b.type === "text" || b.type === "heading") {
      exact(b, ["type", "text"]);
      return {
        type: b.type,
        text: text(b.text, b.type === "heading" ? 200 : 8000),
      };
    }
    if (b.type === "details") {
      exact(b, ["type", "title", "text"]);
      return {
        type: b.type,
        title: text(b.title, 200),
        text: text(b.text, 8000),
      };
    }
    const fileId = key(b.fileId);
    if (b.type === "image") {
      exact(b, ["type", "fileId", "alt"]);
      return {
        type: b.type,
        fileId,
        alt: text(b.alt, 300),
      };
    }
    if (b.type === "table") {
      exact(b, ["type", "fileId", "pointer", "columns"]);
      if (
        !Array.isArray(b.columns) ||
        b.columns.length < 1 ||
        b.columns.length > 20
      )
        throw fail();
      return {
        type: b.type,
        fileId,
        pointer: pointer(b.pointer),
        columns: b.columns.map((raw) => {
          const c = objectBody(raw);
          exact(c, ["label", "key"]);
          return {
            label: text(c.label, 200),
            key: key(c.key),
          };
        }),
      };
    }
    if (b.type === "bars") {
      exact(b, ["type", "fileId", "pointer", "labelKey", "valueKey", "title"]);
      return {
        type: b.type,
        fileId,
        pointer: pointer(b.pointer),
        labelKey: key(b.labelKey),
        valueKey: key(b.valueKey),
        title: text(b.title, 200),
      };
    }
    throw fail();
  });
  return {
    version: 1,
    blocks,
  };
}
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}
function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (!["string", "number", "boolean"].includes(typeof value))
    throw new AppError(
      422,
      "invalid_report_data",
      "Report cells must be scalar values.",
    );
  return String(value).slice(0, 4000);
}
export async function creator(ctx: AppContext, a: Asset) {
  const row = await ctx.db.get<any>(
    "SELECT * FROM users WHERE id=? AND enabled=1",
    [a.creator_id],
  );
  if (!row)
    throw new AppError(
      404,
      "report_unavailable",
      "Report source access is unavailable.",
    );
  const user = mapUser(row);
  if (a.project_id) await ctx.requireProject(user, a.project_id ?? undefined);
  else await ctx.requireOrgMember(user, a.org_id);
  return user;
}
export async function source(
  ctx: AppContext,
  a: Asset,
  user: User,
  fileId: string,
) {
  const auth = await authorizeFile(
    ctx,
    user,
    fileId,
    a.project_id ?? undefined,
  );
  if (
    auth.row.org_id !== a.org_id ||
    (auth.row.project_id && auth.row.project_id !== a.project_id)
  )
    throw new AppError(
      403,
      "report_source_scope",
      "Report sources must belong to the report's project or its current library shares.",
    );
  return readCurrentFile(ctx, user, fileId, {
    projectId: a.project_id ?? undefined,
    maxBytes: 4 * 1024 * 1024,
  });
}
export function imageType(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw new AppError(
    422,
    "unsafe_report_image",
    "Use a PNG, JPEG, or WebP image. Charts are rendered as safe SVG by the server.",
  );
}
async function rows(
  ctx: AppContext,
  a: Asset,
  user: User,
  b: Extract<
    Block,
    {
      type: "table" | "bars";
    }
  >,
  readSource?: (id: string) => Promise<Buffer>,
) {
  let data: unknown;
  try {
    data = JSON.parse(
      (
        await (readSource
          ? readSource(b.fileId)
          : source(ctx, a, user, b.fileId))
      ).toString("utf8"),
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      422,
      "invalid_report_data",
      "A report source is not valid JSON.",
    );
  }
  for (const part of b.pointer.split("/").slice(1))
    data =
      data && typeof data === "object" && Object.hasOwn(data, part)
        ? (data as Record<string, unknown>)[part]
        : undefined;
  if (
    !Array.isArray(data) ||
    data.length > 1000 ||
    data.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  )
    throw new AppError(
      422,
      "invalid_report_data",
      "Select an array of at most 1000 records.",
    );
  return data as Record<string, unknown>[];
}
export async function renderReport(ctx: AppContext, a: Asset) {
  const user = await creator(ctx, a),
    report = validateReport(JSON.parse(a.document));
  let sourceBytes = 0,
    contentBytes = 0,
    cells = 0;
  const rendered: string[] = [],
    cache = new Map<string, Buffer>();
  const limited = () =>
    new AppError(413, "report_limit", "The report exceeds the supported size.");
  const append = (value: string) => {
    contentBytes += Buffer.byteLength(value);
    if (contentBytes > 8 * 1024 * 1024) throw limited();
    rendered.push(value);
  };
  const readSource = async (id: string) => {
    const cached = cache.get(id);
    if (cached) return cached;
    // Admission is sequential and bounded before reading; repeated blocks reuse
    // the same authorized snapshot during this render.
    const remaining = 8 * 1024 * 1024 - sourceBytes;
    if (remaining <= 0) throw limited();
    const auth = await authorizeFile(ctx, user, id, a.project_id ?? undefined);
    if (
      auth.row.org_id !== a.org_id ||
      (auth.row.project_id && auth.row.project_id !== a.project_id)
    )
      throw new AppError(
        403,
        "report_source_scope",
        "Report sources must belong to this project or its current library shares.",
      );
    const bytes = await readCurrentFile(ctx, user, id, {
      projectId: a.project_id ?? undefined,
      maxBytes: Math.min(remaining, 4 * 1024 * 1024),
    });
    sourceBytes += bytes.length;
    cache.set(id, bytes);
    return bytes;
  };
  for (const [index, b] of report.blocks.entries()) {
    if (b.type === "text") {
      append(`<p>${escapeHtml(b.text)}</p>`);
      continue;
    }
    if (b.type === "heading") {
      append(`<h2 id="section-${index}">${escapeHtml(b.text)}</h2>`);
      continue;
    }
    if (b.type === "details") {
      append(
        `<details><summary>${escapeHtml(b.title)}</summary><p>${escapeHtml(b.text)}</p></details>`,
      );
      continue;
    }
    if (b.type === "image") {
      const bytes = await readSource(b.fileId);
      append(
        `<figure><img src="data:${imageType(bytes)};base64,${bytes.toString("base64")}" alt="${escapeHtml(b.alt)}"></figure>`,
      );
      continue;
    }
    const data = await rows(ctx, a, user, b, readSource);
    if (b.type === "table") {
      cells += data.length * b.columns.length;
      if (cells > 100000) throw limited();
      append("<table><thead><tr>");
      for (const c of b.columns) append(`<th>${escapeHtml(c.label)}</th>`);
      append("</tr></thead><tbody>");
      for (const row of data) {
        append("<tr>");
        for (const c of b.columns)
          append(
            `<td>${escapeHtml(scalar(Object.hasOwn(row, c.key) ? row[c.key] : null))}</td>`,
          );
        append("</tr>");
      }
      append("</tbody></table>");
      continue;
    }
    const values = data.slice(0, 100).map((row) => ({
      label: scalar(row[b.labelKey]),
      value: row[b.valueKey],
    }));
    if (
      values.some(
        (v) =>
          typeof v.value !== "number" ||
          !Number.isFinite(v.value) ||
          v.value < 0,
      )
    )
      throw new AppError(
        422,
        "invalid_chart_data",
        "Bar charts require finite, nonnegative numbers.",
      );
    const maximum = Math.max(1, ...values.map((v) => v.value as number));
    append(
      `<figure><svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 720 ${values.length * 32 + 40}"><title>${escapeHtml(b.title)}</title>`,
    );
    for (const [i, v] of values.entries())
      append(
        `<text x="0" y="${i * 32 + 24}">${escapeHtml(v.label.slice(0, 24))}</text><rect x="220" y="${i * 32 + 8}" width="${Math.round((Number(v.value) / maximum) * 400)}" height="22" fill="#236447"/><text x="630" y="${i * 32 + 24}">${escapeHtml(v.value)}</text>`,
      );
    append(`</svg><figcaption>${escapeHtml(b.title)}</figcaption></figure>`);
  }
  // Only this constant stylesheet is emitted. No author CSS, URL, HTML or attribute names.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(a.name)}</title><style>body{font:17px system-ui;line-height:1.6;margin:2rem auto;padding:0 1rem;max-width:70rem;color:#172b24;background:#fff}p{white-space:pre-wrap}table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:.5rem;border:1px solid #ccc;text-align:left}img,svg{max-width:100%;height:auto}summary{cursor:pointer}figure{margin:1rem 0}</style></head><body><main><h1>${escapeHtml(a.name)}</h1>${rendered.join("")}</main></body></html>`;
}
export function headers(reply: FastifyReply) {
  reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("cross-origin-resource-policy", "same-origin")
    .header(
      "content-security-policy",
      "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
}
export { registerReports } from "./assets.js";
