import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createDatabase, migrateFoundation } from "./db/index.js";
import { loadConfig } from "./config.js";
import { hashPassword, validatePassword } from "./auth/password.js";
export async function bootstrapOwner(input: {
  email: string;
  name: string;
  password: string;
  stateDir: string;
}): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    throw new Error("A valid owner email is required");
  if (!input.name.trim()) throw new Error("Owner name is required");
  const passwordHash = await hashPassword(validatePassword(input.password));
  const db = await createDatabase(
    join(input.stateDir, "control", "platform.sqlite"),
  );
  try {
    await migrateFoundation(db);
    if (await db.get("SELECT id FROM users WHERE role='owner'"))
      throw new Error(
        "Platform owner already exists; bootstrap will not replace accounts",
      );
    const id = randomUUID();
    await db.run(
      "INSERT INTO users (id,org_id,email,name,role,enabled,password_hash,created_at) VALUES (?,NULL,?,?,'owner',1,?,?)",
      [id, email, input.name.trim(), passwordHash, new Date().toISOString()],
    );
    return id;
  } finally {
    await db.close();
  }
}
async function main() {
  if (
    process.argv[2] !== "bootstrap-owner" ||
    process.argv.slice(3).some((arg) => arg !== "--password-stdin")
  )
    throw new Error(
      "Usage: node cli.js bootstrap-owner [--password-stdin] (WME_OWNER_EMAIL, WME_OWNER_NAME, WME_STATE_DIR)",
    );
  const config = loadConfig();
  let password = "";
  if (process.argv.includes("--password-stdin")) {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      password += chunk;
      if (password.length > 1026)
        throw new Error("Password input exceeds the maximum length");
    }
    password = password.replace(/\r?\n$/, "");
  } else if (process.env.WME_BOOTSTRAP_PASSWORD_FILE) {
    const path = process.env.WME_BOOTSTRAP_PASSWORD_FILE;
    const info = await stat(path);
    if (!info.isFile() || info.size > 4096)
      throw new Error("Password file is invalid");
    password = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  } else password = process.env.WME_BOOTSTRAP_PASSWORD ?? "";
  delete process.env.WME_BOOTSTRAP_PASSWORD;
  const id = await bootstrapOwner({
    email: process.env.WME_OWNER_EMAIL ?? "",
    name: process.env.WME_OWNER_NAME ?? "",
    password,
    stateDir: config.stateDir,
  });
  process.stdout.write(`Platform owner created: ${id}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
