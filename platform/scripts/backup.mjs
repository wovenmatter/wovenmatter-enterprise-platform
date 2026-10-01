#!/usr/bin/env node
// Generic encrypted backup/restore. Destination selection belongs to the operator.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  open,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  lstat,
  readdir,
  readlink,
  symlink,
  chmod,
  chown,
} from "node:fs/promises";
import { resolve, join, dirname, posix } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { backupDatabase, checkDatabase } from "./sqlite-backup.mjs";
const MAGIC = Buffer.from("WMEBACK1");
async function keyFrom(file) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
    throw new Error("Backup key must be a private regular file (0600)");
  const key = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error("Backup key must contain 32 random bytes as hexadecimal");
  return Buffer.from(key, "hex");
}
function path(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Unsafe archive path");
  return value;
}
async function command(argv, extra = []) {
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((v) => typeof v !== "string") ||
    !argv[0].startsWith("/")
  )
    throw new Error("Configure an absolute executable and argument array");
  const p = spawn(argv[0], [...argv.slice(1), ...extra], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const [code] = await once(p, "exit");
  if (code !== 0) throw new Error("Backup operator hook failed");
}
async function write(stream, data) {
  if (stream.destroyed)
    throw stream.errored ?? new Error("Backup stream closed");
  if (!stream.write(data)) {
    if (stream.destroyed)
      throw stream.errored ?? new Error("Backup stream closed");
    await once(stream, "drain");
  }
}
async function openParent(root, relative) {
  let fd = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const p of relative.split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${fd.fd}/${p}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await fd.close();
      fd = next;
    }
    return fd;
  } catch (e) {
    await fd.close();
    throw e;
  }
}
export async function createBackup(config, tag = "daily") {
  if (process.platform !== "linux")
    throw new Error("Backup requires Linux descriptor safety");
  if (!["daily", "pre-update", "manual"].includes(tag))
    throw new Error("Invalid backup tag");
  const key = await keyFrom(config.keyFile),
    roots = Object.entries(config.roots ?? {});
  if (!roots.length || roots.length > 16)
    throw new Error("Configure explicit data roots");
  for (const [label, root] of roots) {
    if (
      !/^[a-z][a-z0-9_-]{0,31}$/.test(label) ||
      typeof root !== "string" ||
      resolve(root) === "/"
    )
      throw new Error("Invalid backup root");
  }
  if (!config.transport)
    throw new Error(
      "Backup destination is deferred: configure an off-host transport before enabling backups",
    );
  const database = resolve(config.database);
  if (
    !roots.some(([, root]) => {
      const r = resolve(root);
      return database.startsWith(r + "/");
    })
  )
    throw new Error("Configured roots must include the application database");
  const stage = await mkdtemp(
    join(config.stagingDirectory ?? tmpdir(), "wme-backup-"),
  );
  await chmod(stage, 0o700);
  const name = `wme-${new Date().toISOString().replaceAll(":", "-")}-${tag}-${randomUUID()}.wmeb`,
    target = join(stage, name);
  let quiesced = false,
    archiveStream,
    encryption;
  try {
    // Operator-controlled hooks pause writers across ALL configured hosts and the
    // control plane. They must fail closed if a host cannot be quiesced.
    quiesced = true;
    await command(config.quiesce);
    const snapshot = join(stage, "database.sqlite");
    await backupDatabase(config.database, snapshot);
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    const header = await open(target, "wx", 0o600);
    try {
      await header.writeFile(Buffer.concat([MAGIC, iv]));
    } finally {
      await header.close();
    }
    archiveStream = new PassThrough();
    encryption = pipeline(
      archiveStream,
      cipher,
      createWriteStream(target, {
        flags: "a",
        mode: 0o600,
      }),
    );
    void encryption.catch(() => {});
    const record = (value) =>
      write(archiveStream, JSON.stringify(value) + "\n");
    await record({
      type: "header",
      version: 1,
      createdAt: new Date().toISOString(),
      tag,
    });
    let count = 0;
    async function walk(root, relative, label) {
      const parent = await openParent(root, relative);
      try {
        const anchored = `/proc/self/fd/${parent.fd}/.`;
        for (const name of (await readdir(anchored)).sort()) {
          const item = relative ? `${relative}/${name}` : name,
            archive = path(`${label}/${item}`),
            leaf = `${anchored}/${name}`;
          if (++count > 1000000) throw new Error("Backup entry limit");
          if (
            resolve(root, item) === resolve(config.database) + "-wal" ||
            resolve(root, item) === resolve(config.database) + "-shm"
          )
            continue;
          const stat = await lstat(leaf);
          if (stat.isSymbolicLink()) {
            const target = await readlink(leaf);
            if (target.length > 4096 || /[\x00-\x1f]/.test(target))
              throw new Error("Invalid symlink metadata");
            await record({
              type: "symlink",
              path: archive,
              target,
            });
          } else if (stat.isDirectory()) {
            await record({
              type: "directory",
              path: archive,
              mode: stat.mode & 0o777,
              uid: stat.uid,
              gid: stat.gid,
            });
            await walk(root, item, label);
          } else if (stat.isFile()) {
            const file = await open(
              resolve(root, item) === resolve(config.database)
                ? snapshot
                : leaf,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const st = await file.stat();
              if (!st.isFile() || st.nlink !== 1)
                throw new Error("Backup contains a nonordinary file");
              await record({
                type: "file",
                path: archive,
                mode: stat.mode & 0o777,
                uid: stat.uid,
                gid: stat.gid,
              });
              for (;;) {
                const chunk = Buffer.allocUnsafe(128 * 1024),
                  r = await file.read(chunk, 0, chunk.length, null);
                if (!r.bytesRead) break;
                await record({
                  type: "chunk",
                  data: chunk.subarray(0, r.bytesRead).toString("base64"),
                });
              }
              await record({
                type: "endfile",
              });
            } finally {
              await file.close();
            }
          } else if (!stat.isSocket())
            throw new Error("Backup contains an unsupported device or FIFO");
        }
      } finally {
        await parent.close();
      }
    }
    for (const [label, root] of roots) {
      const st = await lstat(root);
      await record({
        type: "directory",
        path: label,
        mode: st.mode & 0o777,
        uid: st.uid,
        gid: st.gid,
      });
      await walk(resolve(root), "", label);
    }
    archiveStream.end();
    await encryption;
    const footer = await open(target, "a");
    try {
      await footer.writeFile(cipher.getAuthTag());
    } finally {
      await footer.close();
    }
    const fd = await open(target, "r");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await command(config.resume);
    quiesced = false;
    await command(config.transport, ["put", target, name]);
    await command(config.transport, [
      "prune",
      new Date(Date.now() - 30 * 86400_000).toISOString(),
    ]);
    return {
      name,
      encrypted: true,
      retentionDays: 30,
      entries: count,
    };
  } finally {
    archiveStream?.destroy();
    await encryption?.catch(() => {});
    key.fill(0);
    try {
      if (quiesced) await command(config.resume);
    } finally {
      await rm(stage, {
        recursive: true,
        force: true,
      });
    }
  }
}
export async function restoreBackup(archive, keyFile, destination) {
  const key = await keyFrom(keyFile),
    root = resolve(destination),
    stage = await mkdtemp(join(tmpdir(), "wme-restore-"));
  await chmod(stage, 0o700);
  let current;
  try {
    const fd = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW),
      st = await fd.stat();
    if (!st.isFile() || st.size < 36) throw new Error("Invalid backup");
    const header = Buffer.alloc(20),
      tag = Buffer.alloc(16);
    await fd.read(header, 0, 20, 0);
    await fd.read(tag, 0, 16, st.size - 16);
    await fd.close();
    if (!header.subarray(0, 8).equals(MAGIC))
      throw new Error("Unsupported backup");
    const decrypt = createDecipheriv("aes-256-gcm", key, header.subarray(8));
    decrypt.setAuthTag(tag);
    const plaintext = join(stage, "archive.jsonl");
    // Authenticate the entire archive before creating ANY restored files.
    await pipeline(
      createReadStream(archive, {
        start: 20,
        end: st.size - 17,
      }),
      decrypt,
      createWriteStream(plaintext, {
        flags: "wx",
        mode: 0o600,
      }),
    );
    await mkdir(root, {
      mode: 0o700,
    });
    await writeFilePrivate(
      join(root, ".restore-incomplete"),
      "Restore in progress",
    );
    const links = [],
      directories = [];
    let seenHeader = false,
      count = 0;
    for await (const line of createInterface({
      input: createReadStream(plaintext),
      crlfDelay: Infinity,
    })) {
      if (line.length > 200000) throw new Error("Archive record limit");
      const r = JSON.parse(line);
      if (r.type === "header") {
        if (seenHeader || r.version !== 1)
          throw new Error("Invalid archive header");
        seenHeader = true;
        continue;
      }
      if (!seenHeader || ++count > 10000000)
        throw new Error("Archive record limit");
      if (r.type === "chunk") {
        if (
          !current ||
          typeof r.data !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            r.data,
          )
        )
          throw new Error("Invalid file chunk");
        await current.writeFile(Buffer.from(r.data, "base64"));
        continue;
      }
      if (r.type === "endfile") {
        if (!current) throw new Error("Invalid file end");
        await current.sync();
        await current.close();
        current = undefined;
        continue;
      }
      if (current) throw new Error("Unterminated file");
      const relative = path(r.path),
        target = join(root, relative);
      const parent = await openParent(
        root,
        posix.dirname(relative) === "." ? "" : posix.dirname(relative),
      );
      try {
        const leaf = `/proc/self/fd/${parent.fd}/${posix.basename(relative)}`;
        if (r.type === "directory") {
          await mkdir(leaf, {
            mode: 0o700,
          });
          directories.push([target, Number(r.mode) & 0o777, r.uid, r.gid]);
        } else if (r.type === "file") {
          current = await open(
            leaf,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            Number(r.mode) & 0o777,
          );
          if (
            !Number.isSafeInteger(r.uid) ||
            !Number.isSafeInteger(r.gid) ||
            r.uid < 0 ||
            r.gid < 0
          )
            throw new Error("Invalid file ownership");
          await current.chown(r.uid, r.gid);
          await current.chmod(Number(r.mode) & 0o777);
        } else if (r.type === "symlink") {
          if (
            typeof r.target !== "string" ||
            r.target.length > 4096 ||
            /[\x00-\x1f]/.test(r.target)
          )
            throw new Error("Unsafe archive symlink");
          links.push([relative, r.target]);
        } else throw new Error("Unsupported archive record");
      } finally {
        await parent.close();
      }
    }
    if (current || !seenHeader) throw new Error("Incomplete backup");
    for (const [relative, target] of links) {
      const parent = await openParent(root, posix.dirname(relative));
      try {
        await symlink(
          target,
          `/proc/self/fd/${parent.fd}/${posix.basename(relative)}`,
        );
      } finally {
        await parent.close();
      }
    }
    for (const [dir, mode, uid, gid] of directories.reverse()) {
      if (
        !Number.isSafeInteger(uid) ||
        !Number.isSafeInteger(gid) ||
        uid < 0 ||
        gid < 0
      )
        throw new Error("Invalid directory ownership");
      await chown(dir, uid, gid);
      await chmod(dir, mode);
    }
    // SQLite integrity is checked for every restored SQLite file before success.
    async function check(dir) {
      for (const name of await readdir(dir)) {
        const p = join(dir, name),
          st = await lstat(p);
        if (st.isDirectory()) await check(p);
        else if (st.isFile() && name.endsWith(".sqlite")) checkDatabase(p);
      }
    }
    await check(root);
    await rm(join(root, ".restore-incomplete"));
    return {
      restored: true,
      destination: root,
    };
  } finally {
    key.fill(0);
    await current?.close();
    await rm(stage, {
      recursive: true,
      force: true,
    });
  }
}
async function writeFilePrivate(path, data) {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(data);
  } finally {
    await f.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [commandName, ...args] = process.argv.slice(2);
    if (commandName === "backup" && args[0])
      console.log(
        JSON.stringify(
          await createBackup(
            JSON.parse(await readFile(args[0], "utf8")),
            args[1] ?? "daily",
          ),
        ),
      );
    else if (commandName === "restore" && args.length === 3)
      console.log(JSON.stringify(await restoreBackup(...args)));
    else
      throw new Error(
        "Usage: backup.mjs backup PRIVATE_CONFIG [daily|pre-update|manual] | restore ARCHIVE KEY_FILE NEW_DIRECTORY",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
