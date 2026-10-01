#!/usr/bin/env node
import { DatabaseSync, backup } from "node:sqlite";
import { chmod, mkdir, mkdtemp, link, rm, lstat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function checkDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
      throw new Error("SQLite integrity check failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("SQLite foreign key check failed");
    return {
      integrity: "ok",
      tables: db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
        )
        .get().count,
    };
  } finally {
    db.close();
  }
}
export async function backupDatabase(source, target) {
  source = resolve(source);
  target = resolve(target);
  if (source === target)
    throw new Error("Backup destination must differ from source");
  // Opening read-only avoids accidentally creating a new empty database on a typo.
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
    throw new Error("Source must be a regular database file");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await lstat(target);
    throw new Error("Refusing to replace an existing backup");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryDirectory = await mkdtemp(
    join(dirname(target), ".sqlite-backup-"),
  );
  await chmod(temporaryDirectory, 0o700);
  const temporary = join(temporaryDirectory, "snapshot.sqlite");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, temporary); // SQLite online-backup API includes committed WAL content.
    await chmod(temporary, 0o600);
    const result = checkDatabase(temporary);
    // Same-filesystem hard link atomically publishes without replacing a racing writer.
    await link(temporary, target);
    return result;
  } finally {
    db.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , command, source, target] = process.argv;
  try {
    if (command === "backup" && source && target)
      console.log(JSON.stringify(await backupDatabase(source, target)));
    else if (command === "check" && source && !target)
      console.log(JSON.stringify(checkDatabase(resolve(source))));
    else
      throw new Error(
        "Usage: sqlite-backup.mjs backup SOURCE DESTINATION | check DATABASE",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
