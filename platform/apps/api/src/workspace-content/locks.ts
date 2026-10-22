import type { AppContext } from "../context.js";
const lanes = new WeakMap<AppContext, Map<string, Promise<unknown>>>();
export function withContentLock<T>(ctx: AppContext, id: string, work: () => Promise<T>) {
  let entries = lanes.get(ctx);
  if (!entries) { entries = new Map(); lanes.set(ctx, entries); }
  const result = (entries.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
  entries.set(id, result);
  void result.finally(() => { if (entries!.get(id) === result) entries!.delete(id); }).catch(() => {});
  return result;
}
