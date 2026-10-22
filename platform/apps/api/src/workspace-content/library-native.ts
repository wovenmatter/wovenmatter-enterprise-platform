import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AppContext } from "../context.js";

const chunkBytes = 262144;
const maxParts = 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: any): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const root = (value: any) => object(value) && ["childID", "parentNativeConversationID", "parentNativeSessionID"].every(key => value[key] === undefined);
function json(value: unknown, limit: number): any {
  if (typeof value !== "string" || value.length > limit || Buffer.byteLength(value) > limit) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function sameMetadata(record: any, original: any, runId: string) {
  return object(record) && record.id === original.id && record.revision === original.revision
    && record.kind === original.kind && record.runID === original.runID
    && (record.runID === undefined || record.runID === runId);
}

/** Reconstruct only delivered root-message candidates from the authenticated
 * archive scope. The caller still applies its assistant/content parser and
 * current workspace authorization; this never expands tool or private records. */
export async function restoreLibraryNativeRecord(ctx: AppContext, runId: string, sourceId: string, record: any): Promise<any | null> {
  if (!object(record)) return null;
  if (record.kind === "native-file.chunk") return null;
  if (record.kind !== "native-file.manifest") return record;
  if (!runId || !sourceId || sourceId.length > 1024) return null;
  const configured = Number(ctx.config.maxFileBytes ?? 25 * 1024 ** 2);
  const fileLimit = Number.isSafeInteger(configured) && configured > 0 ? Math.min(25 * 1024 ** 2, configured) : 25 * 1024 ** 2;
  // Pi's archive includes both payload and public projection with base64 media.
  // Bound the serialized outer record, not merely the final decoded attachment.
  const maxSerialized = 3 * fileLimit + 2 * 1024 ** 2;
  const manifest = json(record.payload, 1024 ** 2), projection = json(record.projectionJSON, 16384);
  const original = manifest?.originalRecord;
  if (!object(manifest) || manifest.format !== "woven-native-file-manifest/v2"
    || !root(original) || !["message", "pi.assistant"].includes(original.kind)
    || typeof original.id !== "string" || !original.id || original.id.length > 1024
    || (original.revision !== undefined && !["string", "number"].includes(typeof original.revision))
    || (original.runID !== undefined && original.runID !== runId)
    || record.runID !== original.runID || record.revision !== undefined
    || !root(projection) || !isDeepStrictEqual(projection.originalRecord, original)
    || !digest(manifest.sourceSHA256) || !digest(manifest.sha256)
    || !integer(manifest.totalBytes) || manifest.totalBytes <= 0 || manifest.totalBytes > maxSerialized
    || !integer(manifest.sourceTotalBytes) || manifest.sourceTotalBytes <= 0 || manifest.sourceTotalBytes > maxSerialized
    || manifest.chunkBytes !== chunkBytes || manifest.manifestPage !== 0 || manifest.manifestPages !== 1
    || record.id !== `native-file.manifest:${manifest.sourceSHA256}:0`
    || !["exact-native-bytes", "tool-endpoint-redacted"].includes(manifest.byteFidelity)
    || (manifest.byteFidelity === "exact-native-bytes" && (manifest.sha256 !== manifest.sourceSHA256 || manifest.totalBytes !== manifest.sourceTotalBytes))
    || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > maxParts
    || manifest.parts.length !== Math.ceil(manifest.totalBytes / chunkBytes)) return null;
  // Authenticate the manifest against its already-persisted run/source, too.
  const saved = await ctx.db.get<{payload: string}>("SELECT payload FROM conversation_native_records WHERE run_id=? AND source_id=? AND record_id=? AND revision='' AND kind='native-file.manifest' AND length(CAST(payload AS BLOB))<=?", [runId, sourceId, record.id, 2 * 1024 ** 2]);
  if (!saved || !isDeepStrictEqual(json(saved.payload, 2 * 1024 ** 2), record)) return null;
  let offset = 0;
  // Validate the entire bounded descriptor list before allocating record space.
  for (const part of manifest.parts) {
    if (!object(part) || part.byteOffset !== offset || !integer(part.byteCount)
      || part.byteCount !== Math.min(chunkBytes, manifest.totalBytes - offset)
      || typeof part.chunkID !== "string"
      || !new RegExp(`^native-record:${manifest.sourceSHA256}:native-file\\.chunk:[a-f0-9]{64}$`).test(part.chunkID)) return null;
    offset += part.byteCount;
  }
  if (offset !== manifest.totalBytes) return null;
  const bytes = Buffer.alloc(manifest.totalBytes), whole = createHash("sha256");
  for (const part of manifest.parts) {
    // Sequential bounded reads avoid retaining all base64 rows simultaneously.
    const row = await ctx.db.get<{payload: string}>("SELECT payload FROM conversation_native_records WHERE run_id=? AND source_id=? AND record_id=? AND revision='' AND kind='native-file.chunk' AND length(CAST(payload AS BLOB))<=?", [runId, sourceId, part.chunkID, 2 * 1024 ** 2]);
    const chunk = json(row?.payload, 2 * 1024 ** 2), body = json(chunk?.payload, 2 * chunkBytes), group = json(chunk?.projectionJSON, 16384);
    if (!object(chunk) || chunk.id !== part.chunkID || chunk.kind !== "native-file.chunk" || chunk.revision !== undefined
      || chunk.runID !== original.runID || !root(group) || !isDeepStrictEqual(group.originalRecord, original)
      // Native chunk IDs are content-addressed: equal bytes at distinct offsets
      // deliberately share an ID, and the durable table retains one projection.
      // Its original offset must still be a real matching manifest reference.
      || !manifest.parts.some((reference: any) => reference.chunkID === part.chunkID && reference.byteOffset === group.byteOffset && reference.byteCount === group.byteCount)
      || group.byteCount !== part.byteCount
      || !object(body) || body.format !== "woven-native-file-chunk/v1" || body.encoding !== "base64"
      || !digest(body.sha256) || !part.chunkID.endsWith(":" + body.sha256)
      || typeof body.dataBase64 !== "string" || body.dataBase64.length !== Math.ceil(part.byteCount / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.dataBase64)) return null;
    const piece = Buffer.from(body.dataBase64, "base64");
    if (piece.length !== part.byteCount || piece.toString("base64") !== body.dataBase64 || hash(piece) !== body.sha256) return null;
    piece.copy(bytes, part.byteOffset); whole.update(piece);
  }
  if (whole.digest("hex") !== manifest.sha256) return null;
  let restored: any;
  try { restored = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); } catch { return null; }
  if (!sameMetadata(restored, original, runId)) return null;
  const restoredProjection = restored.projectionJSON === undefined ? {} : json(restored.projectionJSON, maxSerialized);
  if (!root(restoredProjection) || !root(restored)) return null;
  for (const key of ["nativeConversationID", "parentNativeConversationID", "parentNativeSessionID", "childID"])
    if (original[key] !== undefined && restoredProjection[key] !== original[key]) return null;
  return restored;
}
