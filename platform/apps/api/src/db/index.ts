import { Worker } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
export type SqlValue = string | number | null | Uint8Array;
export interface Statement {
  sql: string;
  params?: SqlValue[];
  expectChanges?: number;
}
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}
export interface Database {
  get<T = Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
  ): Promise<T | undefined>;
  all<T = Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
  ): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  batch(statements: Statement[]): Promise<RunResult[]>;
  migrate(name: string, sql: string): Promise<void>;
  close(): Promise<void>;
}
export async function createDatabase(filename: string): Promise<Database> {
  if (filename !== ":memory:")
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const js = new URL("./worker.js", import.meta.url);
  const worker = new Worker(
    existsSync(js) ? js : new URL("./worker.ts", import.meta.url),
    { workerData: { filename } },
  );
  let nextId = 0;
  let closed = false;
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  const waiting = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = (error: Error) => {
    closed = true;
    readyReject(error);
    for (const waiter of waiting.values()) waiter.reject(error);
    waiting.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (!closed) fail(new Error(`Database worker exited (${code})`));
  });
  worker.on("message", (message) => {
    if (message.ready) {
      readyResolve();
      return;
    }
    const waiter = waiting.get(message.id);
    if (!waiter) return;
    waiting.delete(message.id);
    if (message.error)
      waiter.reject(
        Object.assign(new Error(message.error.message), {
          code: message.error.code,
          ...(message.error.code === "database_busy"
            ? { statusCode: 503 }
            : {}),
        }),
      );
    else waiter.resolve(message.result);
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  const call = (method: string, ...args: any[]): Promise<any> => {
    if (closed || (closing && method !== "close"))
      return Promise.reject(new Error("Database is closed"));
    if (waiting.size >= 2048 && method !== "close")
      return Promise.reject(
        Object.assign(new Error("Database is busy"), {
          code: "database_busy",
          statusCode: 503,
        }),
      );
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  };
  return {
    get: (sql, params) => call("get", sql, params),
    all: (sql, params) => call("all", sql, params),
    run: (sql, params) => call("run", sql, params),
    batch: (statements) => call("batch", statements),
    migrate: (name, sql) => call("migrate", name, sql),
    close: () => {
      if (closingPromise) return closingPromise;
      if (closed) return Promise.resolve();
      closing = true;
      closingPromise = (async () => {
        try {
          await call("close");
        } finally {
          closed = true;
          await worker.terminate();
        }
      })();
      return closingPromise;
    },
  };
}
export { migrateFoundation } from "./schema.js";
