import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { AppError, type AppContext, type User } from "../context.js";
import { withProjectLifecycle } from "../projects/trash.js";

// Adapted from remote/src/database-catalog.mjs at source commit
// 04fe05090e107df92c498a4563b742978c91d933. The server owns the catalog;
// native runtimes never receive its path or control-plane database authority.
const helper = fileURLToPath(new URL("./database-catalog.py", import.meta.url));
let activeRequests = 0;
export function databaseOperation(ctx: AppContext, user: User, projectId: string, request: Record<string, unknown>) {
  return withProjectLifecycle(ctx, projectId, () => operate(ctx, user, projectId, request));
}
async function operate(ctx: AppContext, user: User, projectId: string, request: Record<string, unknown>) {
  const project = await ctx.requireProject(user, projectId, "write");
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new AppError(400, "invalid_workspace", "Invalid workspace.");
  if (!["list", "create", "copy", "snapshot", "query", "data", "execute"].includes(String(request.action)))
    throw new AppError(400, "invalid_operation", "Choose a database operation.");
  if (activeRequests >= 4) throw new AppError(429, "database_busy", "The database service is busy. Try again.");
  const root = join(ctx.config.stateDir, "workspace-datasets", projectId);
  activeRequests++;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const result = await new Promise<Record<string, any>>((resolve, reject) => {
      const child = spawn("/usr/bin/python3", ["-I", helper, root, join(ctx.config.stateDir, "control", "platform.sqlite"), user.id, projectId], {
        stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      });
      const chunks: Buffer[] = []; let size = 0, failure: Error | undefined;
      const stop = (message: string) => { failure = new AppError(400, "database_limit", message); child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop("Database request timed out. Try a smaller query."), 10000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 48 * 1024 * 1024) stop("Database response is too large.");
        else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timer); reject(new AppError(503, "database_unavailable", "Database service unavailable.")); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (signal) return reject(new AppError(400, "database_limit", "Database resource limit exceeded."));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          // Python/SQLite errors can contain host paths. Return a stable safe
          // message, and leave native execution diagnostics inside the boundary.
          if (code !== 0) return reject(new AppError(400, "database_request_failed", "The database request failed. Check the SQL, database name and resource limits."));
          resolve(result);
        } catch { reject(new AppError(503, "database_unavailable", "Database service unavailable.")); }
      });
      child.stdin.end(JSON.stringify(request));
    });
    await ctx.requireProject(user, projectId);
    const sanitize = (row: Record<string, unknown>) => { const { url, owner, ...safe } = row; return safe; };
    if (result.databases) result.databases = result.databases.map(sanitize);
    if (result.database) result.database = sanitize(result.database);
    if (result.url) { delete result.url; delete result.owner; }
    if (["create", "copy", "execute"].includes(String(request.action)))
      await ctx.audit(user, project.orgId, "workspace_database." + request.action, String(result.id), {});
    return result;
  } finally { activeRequests--; }
}
