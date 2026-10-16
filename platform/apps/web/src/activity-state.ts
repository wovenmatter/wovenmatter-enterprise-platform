export interface Activity {
  ordinal: number;
  runId: string;
  key: string;
  kind: string;
  title: string;
  status: string;
  preview: string;
  metadata: Record<string, unknown>;
  revision: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ActivityPage {
  items: Activity[];
  cursor: string;
  hasMore: boolean;
  nextBefore: number | null;
}
export function mergeActivities(
  current: Activity[],
  incoming: Activity[],
): Activity[] {
  const items = new Map(
    current.map((item) => [item.runId + "/" + item.key, item]),
  );
  for (const item of incoming) {
    const key = item.runId + "/" + item.key,
      previous = items.get(key);
    if (previous && previous.revision > item.revision) continue;
    if (!previous || previous.revision !== item.revision) items.set(key, item);
  }
  return [...items.values()].sort((a, b) => a.ordinal - b.ordinal);
}
export type WorkPart =
  | { kind: "text"; item: Activity }
  | { kind: "activity"; item: Activity }
  | { kind: "work"; id: string; items: Activity[] };
export function workParts(items: Activity[]): WorkPart[] {
  const result: WorkPart[] = [];
  for (const item of items) {
    if (
      item.deleted ||
      item.kind === "checklist" ||
      (item.kind === "thinking" && !item.preview.trim())
    )
      continue;
    if (item.kind === "message" || item.kind === "final")
      result.push({ kind: "text", item });
    else if (!["tool", "thinking"].includes(item.kind))
      result.push({ kind: "activity", item });
    else {
      const prior = result.at(-1);
      if (prior?.kind === "work") prior.items.push(item);
      else
        result.push({
          kind: "work",
          id: item.runId + "/" + item.key,
          items: [item],
        });
    }
  }
  return result;
}
