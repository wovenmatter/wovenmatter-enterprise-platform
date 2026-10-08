import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
const db = new DatabaseSync(workerData.filename);
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
);
if (workerData.filename !== ":memory:") chmodSync(workerData.filename, 0o600);
db.exec(
  "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
);
function run(sql: string, params: any[] = []) {
  const r = db.prepare(sql).run(...params);
  return {
    changes: Number(r.changes),
    lastInsertRowid: Number(r.lastInsertRowid),
  };
}
parentPort!.on("message", ({ id, method, args }) => {
  try {
    let result: unknown;
    if (method === "get") result = db.prepare(args[0]).get(...(args[1] ?? []));
    else if (method === "all")
      result = db.prepare(args[0]).all(...(args[1] ?? []));
    else if (method === "run") result = run(args[0], args[1]);
    else if (method === "batch") {
      db.exec("BEGIN IMMEDIATE");
      try {
        result = args[0].map((s: any) => {
          const r = run(s.sql, s.params);
          if (s.expectChanges !== undefined && r.changes !== s.expectChanges)
            throw new Error("Concurrent update conflict");
          return r;
        });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } else if (method === "migrate") {
      // SQLite records deferred DROP-parent violations even when an identical
      // replacement is installed. A trusted schema rebuild needs FK checks off
      // OUTSIDE its transaction, followed by an explicit complete validation.
      // This synchronous worker cannot process another request in this window.
      const rebuild = args[2]?.rebuild === true;
      let inTransaction = false;
      try {
        if (rebuild) db.exec("PRAGMA foreign_keys=OFF");
        db.exec("BEGIN IMMEDIATE");
        inTransaction = true;
        if (
          !db
            .prepare("SELECT name FROM schema_migrations WHERE name=?")
            .get(args[0])
        ) {
          db.exec(args[1]);
          if (rebuild && db.prepare("PRAGMA foreign_key_check").all().length)
            throw new Error("Schema rebuild violates foreign keys");
          run("INSERT INTO schema_migrations VALUES (?,?)", [
            args[0],
            new Date().toISOString(),
          ]);
        }
        db.exec("COMMIT");
      } catch (e) {
        if (inTransaction) db.exec("ROLLBACK");
        throw e;
      } finally {
        if (rebuild) {
          try {
            db.exec("PRAGMA foreign_keys=ON");
            if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
              throw new Error("Foreign-key enforcement could not be restored");
          } catch (error) {
            // Refuse every subsequent request if enforcement cannot be restored.
            db.close();
            throw error;
          }
        }
      }
    } else if (method === "close") {
      db.close();
      parentPort!.postMessage({ id, result: null });
      parentPort!.close();
      return;
    } else throw new Error("Unknown database operation");
    parentPort!.postMessage({ id, result });
  } catch (error: any) {
    parentPort!.postMessage({
      id,
      error: {
        message: [5, 6].includes(Number(error.errcode) & 0xff)
          ? "Database is busy"
          : error.message,
        code: [5, 6].includes(Number(error.errcode) & 0xff)
          ? "database_busy"
          : error.code,
      },
    });
  }
});
parentPort!.postMessage({ ready: true });
