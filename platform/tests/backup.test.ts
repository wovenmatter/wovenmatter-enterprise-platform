import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  chmod,
  symlink,
  readlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
// The production operator utility stays plain JavaScript for use before deployment.
const { createBackup, restoreBackup } = await import(
  new URL("../../scripts/backup.mjs", import.meta.url).href
);
test("encrypted backups include committed SQLite, files and native state; restore authenticates before writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wme-encrypted-backup-"));
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  const state = join(root, "state"),
    offhost = join(root, "transport-fixture"),
    key = join(root, "key"),
    hook = join(root, "transport.mjs");
  await mkdir(state);
  await mkdir(offhost);
  await writeFile(key, randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
  const db = new DatabaseSync(join(state, "platform.sqlite"));
  db.exec(
    "CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('private-fixture-value')",
  );
  db.close();
  await mkdir(join(state, "workspace-control"));
  const journal = new DatabaseSync(
    join(state, "workspace-control/workspace.sqlite"),
  );
  journal.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE receipts(id TEXT PRIMARY KEY,cursor INTEGER); INSERT INTO receipts VALUES('accepted-no-replay',4)",
  );
  journal.close();
  await mkdir(join(state, "native"));
  await writeFile(join(state, "native/history"), "durable-native");
  await symlink("/usr/bin/python3", join(state, "native/python"));
  await writeFile(
    hook,
    `import {copyFile,appendFile} from 'node:fs/promises';import {join} from 'node:path';const [dir,op,...args]=process.argv.slice(2);if(op==='put')await copyFile(args[0],join(dir,args[1]));await appendFile(join(dir,'operations'),op+'\\n');`,
  );
  const config = {
    database: join(state, "platform.sqlite"),
    roots: {
      state,
    },
    keyFile: key,
    quiesce: [process.execPath, "-e", "process.exit(0)"],
    resume: [process.execPath, "-e", "process.exit(0)"],
    transport: [process.execPath, hook, offhost],
    stagingDirectory: root,
  };
  await assert.rejects(
    createBackup({
      ...config,
      transport: undefined,
    }),
    /destination is deferred/,
  );
  const result = await createBackup(config, "pre-update"),
    archive = join(offhost, result.name),
    bytes = await readFile(archive);
  assert.equal(result.retentionDays, 30);
  assert.equal(bytes.includes(Buffer.from("private-fixture-value")), false);
  assert.equal(
    await readFile(join(offhost, "operations"), "utf8"),
    "put\nprune\n",
  );
  const restored = join(root, "restored");
  await restoreBackup(archive, key, restored);
  assert.equal(
    await readFile(join(restored, "state/native/history"), "utf8"),
    "durable-native",
  );
  assert.equal(
    await readlink(join(restored, "state/native/python")),
    "/usr/bin/python3",
  );
  assert.equal(
    (await stat(join(restored, "state/native/history"))).uid,
    (await stat(join(state, "native/history"))).uid,
  );
  const copy = new DatabaseSync(join(restored, "state/platform.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    copy.prepare("SELECT value FROM example").get()!.value,
    "private-fixture-value",
  );
  copy.close();
  const restoredJournal = new DatabaseSync(
    join(restored, "state/workspace-control/workspace.sqlite"),
    { readOnly: true },
  );
  assert.equal(
    restoredJournal
      .prepare("SELECT cursor FROM receipts WHERE id='accepted-no-replay'")
      .get()!.cursor,
    4,
  );
  restoredJournal.close();
  assert.equal(
    (await readdir(restored)).includes(".restore-incomplete"),
    false,
  );
  await assert.rejects(restoreBackup(archive, key, restored), /EEXIST/);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(join(root, "tampered"), bytes);
  const rejected = join(root, "rejected");
  await assert.rejects(restoreBackup(join(root, "tampered"), key, rejected));
  await assert.rejects(stat(rejected), {
    code: "ENOENT",
  });
  await chmod(key, 0o644);
  await assert.rejects(createBackup(config), /private regular file/);
});
test("backup rejects omitted database, resumes partial quiescence, and unwinds stream I/O failure", async (t) => {
  const { syncBuiltinESMExports } = await import("node:module"),
    fs = await import("node:fs"),
    { Writable } = await import("node:stream");
  const root = await mkdtemp(join(tmpdir(), "wme-backup-failure-"));
  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );
  const state = join(root, "state"),
    key = join(root, "key"),
    marks = join(root, "marks");
  await mkdir(state);
  await writeFile(key, randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
  const db = new DatabaseSync(join(state, "db.sqlite"));
  db.exec("CREATE TABLE example(v)");
  db.close();
  const mark = (value: string, fail = false) => [
    process.execPath,
    "-e",
    `require('fs').appendFileSync(process.argv[1],${JSON.stringify(value)});process.exit(${fail ? 1 : 0})`,
    marks,
  ];
  const config = {
    database: join(state, "db.sqlite"),
    roots: {
      state,
    },
    keyFile: key,
    quiesce: mark("paused\n"),
    resume: mark("resumed\n"),
    transport: [process.execPath, "-e", "process.exit(0)"],
    stagingDirectory: root,
  };
  await assert.rejects(
    createBackup({
      ...config,
      roots: {
        empty: root + "/empty",
      },
    }),
    /include the application database/,
  );
  await assert.rejects(
    createBackup({
      ...config,
      quiesce: mark("partial\n", true),
    }),
    /hook failed/,
  );
  assert.equal(await readFile(marks, "utf8"), "partial\nresumed\n");
  const original = fs.default.createWriteStream;
  try {
    fs.default.createWriteStream = (() =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(
            Object.assign(new Error("Injected full disk"), {
              code: "ENOSPC",
            }),
          );
        },
      })) as unknown as typeof original;
    syncBuiltinESMExports();
    await assert.rejects(createBackup(config), /Injected full disk/);
  } finally {
    fs.default.createWriteStream = original;
    syncBuiltinESMExports();
  }
  assert.equal(
    await readFile(marks, "utf8"),
    "partial\nresumed\npaused\nresumed\n",
  );
  assert.equal(
    (await readdir(root)).some((n) => n.startsWith("wme-backup-")),
    false,
  );
});
