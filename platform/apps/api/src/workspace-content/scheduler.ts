import { randomUUID } from "node:crypto";
import type { ConversationService } from "../conversations/service.js";
import type { AppContext } from "../context.js";
import type { ContentRow } from "./service.js";
import { withContentLock } from "./locks.js";
import { withProjectLifecycle } from "../projects/trash.js";

type Recurrence = { unit: "day" | "week" | "month"; interval: number };
function parts(at: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const p = Object.fromEntries(values.map(x => [x.type, x.value]));
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, second: +p.second! };
}
function zonedInstant(wall: Date, zone: string) {
  let candidate = wall.getTime();
  const seen = new Set<number>();
  for (let i = 0; i < 4; i++) {
    seen.add(candidate);
    const p = parts(new Date(candidate), zone);
    const delta = wall.getTime() - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!delta) break;
    const next = candidate + delta;
    // A missing wall time oscillates across the DST gap. Match the desktop's
    // forward policy (02:30 becomes 03:30), never fire before the requested time.
    if (seen.has(next)) return Math.max(next, candidate);
    candidate = next;
  }
  return candidate;
}
/** The original start anchors month-end recurrence; missed occurrences never
 * burst on restart. Calendar wall time remains stable across daylight saving. */
export function nextOccurrence(start: string, recurrence: Recurrence | null, zone: string, after: Date): string | null {
  if (!recurrence) return null;
  const initial = new Date(start), p = parts(initial, zone), current = parts(after, zone);
  const step = recurrence.interval;
  let index = recurrence.unit === "month"
    ? Math.max(1, Math.floor(((current.year - p.year) * 12 + current.month - p.month) / step) - 1)
    : Math.max(1, Math.floor((after.getTime() - initial.getTime()) / (86400000 * step * (recurrence.unit === "week" ? 7 : 1))) - 2);
  for (let attempt = 0; attempt < 8; attempt++, index++) {
    const wall = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
    if (recurrence.unit === "month") {
      wall.setUTCDate(1); wall.setUTCMonth(wall.getUTCMonth() + step * index);
      const last = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
      wall.setUTCDate(Math.min(p.day, last));
    } else wall.setUTCDate(wall.getUTCDate() + step * index * (recurrence.unit === "week" ? 7 : 1));
    const at = zonedInstant(wall, zone);
    if (at > after.getTime()) return new Date(at).toISOString();
  }
  throw new Error("Calendar recurrence could not advance");
}

export class WorkspaceScheduler {
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly ctx: AppContext, readonly conversations: Pick<ConversationService, "user" | "create" | "admit">) {}
  start() { this.timer = setInterval(() => void this.tick().catch(() => {}), 5000); this.timer.unref(); }
  async close() { if (this.timer) clearInterval(this.timer); await this.running; }
  tick(now = new Date()) {
    if (this.running) return this.running;
    this.running = this.run(now).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run(now: Date) {
    // A persisted claim without a receipt is uncertain, never an instruction
    // to replay. Read the original admission by its stable ID if it exists.
    const pending = await this.ctx.db.all<any>("SELECT * FROM workspace_task_runs WHERE status IN ('admitting','submitted','accepted','uncertain')");
    for (const p of pending) {
      const receipt = await this.ctx.db.get<any>("SELECT i.run_id,i.delivery,r.status FROM conversation_inputs i LEFT JOIN conversation_runs r ON r.id=i.run_id WHERE i.request_id=? AND i.conversation_id=?", [p.id, p.conversation_id]);
      const status = !receipt ? "uncertain" : receipt.delivery === "pending" ? "submitted" : receipt.delivery === "accepted" ? (["completed", "failed", "cancelled", "interrupted"].includes(receipt.status) ? receipt.status : "accepted") : receipt.delivery;
      const error = status === "uncertain" ? "Admission is uncertain; review before running again." : status === "rejected" ? "The native agent did not accept this scheduled input." : null;
      await this.ctx.db.run("UPDATE workspace_task_runs SET status=?,run_id=?,error=? WHERE id=?", [status, receipt?.run_id ?? p.run_id ?? null, error, p.id]);
      await this.ctx.db.run("UPDATE workspace_task_state SET last_status=?,last_error=? WHERE content_id=? AND NOT EXISTS(SELECT 1 FROM workspace_task_runs WHERE content_id=? AND created_at>?)", [status, error, p.content_id, p.content_id, p.created_at]);
    }
    const due = await this.ctx.db.all<ContentRow & { next_at: string; conversation_id: string | null }>("SELECT c.*,s.next_at,s.conversation_id FROM workspace_content c JOIN workspace_task_state s ON s.content_id=c.id JOIN projects p ON p.id=c.project_id WHERE c.kind='task' AND c.deleted_at IS NULL AND p.status='ready' AND s.next_at<=? ORDER BY s.next_at LIMIT 32", [now.toISOString()]);
    for (const row of due) await withProjectLifecycle(this.ctx, row.project_id, () => withContentLock(this.ctx, row.id, () => this.admit(row, now)));
  }
  private async admit(row: ContentRow & { next_at: string; conversation_id: string | null }, now: Date) {
      const data = JSON.parse(row.data), id = randomUUID();
      if (!data.enabled) return;
      if (await this.ctx.db.get("SELECT 1 FROM workspace_task_runs t JOIN conversation_runs r ON r.id=t.run_id WHERE t.content_id=? AND r.status IN ('queued','dispatching','running','cancelling')", [row.id])) return;
      const next = nextOccurrence(data.startsAt, data.recurrence, data.timeZone, now);
      if (await this.ctx.db.get("SELECT 1 FROM workspace_task_runs WHERE content_id=? AND occurrence=?", [row.id, row.next_at])) {
        await this.ctx.db.run("UPDATE workspace_task_state SET next_at=? WHERE content_id=? AND next_at=? AND EXISTS(SELECT 1 FROM workspace_content WHERE id=? AND revision=?)", [next, row.id, row.next_at, row.id, row.revision]);
        return;
      }
      try {
        await this.ctx.db.batch([
          { sql: "UPDATE workspace_task_state SET next_at=?,last_status='admitting',last_error=NULL WHERE content_id=? AND next_at=? AND EXISTS(SELECT 1 FROM workspace_content WHERE id=? AND revision=? AND deleted_at IS NULL)", params: [next, row.id, row.next_at, row.id, row.revision], expectChanges: 1 },
          { sql: "INSERT INTO workspace_task_runs(id,content_id,occurrence,status,created_at) VALUES(?,?,?,'admitting',?)", params: [id, row.id, row.next_at, now.toISOString()] },
        ]);
      } catch { return; } // Another scheduler or edit won this exact occurrence.
      let attemptingAdmission = false;
      try {
        const user = await this.conversations.user(row.updated_by);
        await this.ctx.requireProject(user, row.project_id, "write");
        let conversationId = row.conversation_id;
        if (!conversationId || data.sessionMode === "new") {
          const chat = await this.conversations.create(user, row.project_id, { title: row.title, harness: data.harness, ...(data.model ? { model: data.model } : {}), folderId: row.folder_id });
          conversationId = chat.id;
        }
        await this.ctx.db.batch([
          { sql: "UPDATE workspace_task_runs SET conversation_id=? WHERE id=?", params: [conversationId, id] },
          { sql: "UPDATE workspace_task_state SET conversation_id=? WHERE content_id=?", params: [conversationId, row.id] },
        ]);
        const unchanged = await this.ctx.db.get("SELECT id FROM workspace_content WHERE id=? AND revision=? AND deleted_at IS NULL", [row.id, row.revision]);
        if (!unchanged) throw new Error("definition_changed");
        attemptingAdmission = true;
        const receipt = await this.conversations.admit(user, conversationId, { content: data.prompt, requestId: id, kind: "message" });
        const runId = receipt.run?.id ?? null;
        const status = receipt.message.delivery === "accepted" ? "accepted" : receipt.message.delivery === "pending" ? "submitted" : receipt.message.delivery ?? "uncertain";
        await this.ctx.db.batch([
          { sql: "UPDATE workspace_task_runs SET status=?,run_id=? WHERE id=?", params: [status, runId, id] },
          { sql: "UPDATE workspace_task_state SET last_status=?,last_error=NULL WHERE content_id=?", params: [status, row.id] },
        ]);
      } catch {
        // Do not store provider diagnostics or prompt text in scheduling errors.
        await this.ctx.db.batch([
          { sql: "UPDATE workspace_task_runs SET status=?,error=? WHERE id=?", params: [attemptingAdmission ? "uncertain" : "failed", attemptingAdmission ? "Task admission is uncertain; review the chat before running again." : "Task could not be admitted. Check current access, agent connection and task settings.", id] },
          { sql: "UPDATE workspace_task_state SET last_status=?,last_error=? WHERE content_id=?", params: [attemptingAdmission ? "uncertain" : "failed", attemptingAdmission ? "Task admission is uncertain; review the chat before running again." : "Task could not be admitted. Check current access, agent connection and task settings.", row.id] },
        ]);
      }
  }
}
