/** WovenMatter calendar wall-time recurrence. Keep in parity with the durable scheduler. */
type Recurrence = { unit: "day" | "week" | "month"; interval: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(at: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); formatters.set(zone, formatter); }
  const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  return { year: +values.year!, month: +values.month!, day: +values.day!, hour: +values.hour!, minute: +values.minute!, second: +values.second! };
}
function zonedInstant(wall: Date, zone: string) {
  let candidate = wall.getTime(); const seen = new Set<number>();
  for (let index = 0; index < 4; index++) {
    seen.add(candidate); const p = parts(new Date(candidate), zone);
    const delta = wall.getTime() - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!delta) break;
    const next = candidate + delta;
    if (seen.has(next)) return Math.max(next, candidate);
    candidate = next;
  }
  return candidate;
}
export function occursOnDay(data: Record<string, unknown>, day: string) {
  const initial = new Date(String(data.startsAt));
  if (!Number.isFinite(initial.getTime())) return false;
  const start = new Date(`${day}T00:00:00`), end = new Date(start); end.setDate(end.getDate() + 1);
  if (initial >= start && initial < end) return true;
  const recurrence = data.recurrence as Recurrence | undefined;
  if (!recurrence || initial >= end) return false;
  const zone = String(data.timeZone ?? "UTC"), anchor = parts(initial, zone), current = parts(start, zone), step = recurrence.interval || 1;
  let index = recurrence.unit === "month" ? Math.max(1, Math.floor(((current.year - anchor.year) * 12 + current.month - anchor.month) / step) - 1) : Math.max(1, Math.floor((start.getTime() - initial.getTime()) / (86400000 * step * (recurrence.unit === "week" ? 7 : 1))) - 2);
  for (let attempt = 0; attempt < 8; attempt++, index++) {
    const wall = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day, anchor.hour, anchor.minute, anchor.second));
    if (recurrence.unit === "month") { wall.setUTCDate(1); wall.setUTCMonth(wall.getUTCMonth() + step * index); const last = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate(); wall.setUTCDate(Math.min(anchor.day, last)); }
    else wall.setUTCDate(wall.getUTCDate() + step * index * (recurrence.unit === "week" ? 7 : 1));
    const at = zonedInstant(wall, zone);
    if (at >= end.getTime()) return false;
    if (at >= start.getTime()) return true;
  }
  return false;
}
