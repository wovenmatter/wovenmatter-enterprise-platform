import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AppError } from "../context.js";
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );
}
export function validatePassword(password: unknown): string {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  )
    throw new AppError(
      400,
      "invalid_password",
      "Password must contain between 12 and 1024 characters",
    );
  return password;
}
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(32);
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string | null,
): Promise<boolean> {
  const parts = encoded?.split("$");
  const valid =
    parts?.length === 6 &&
    parts[0] === "scrypt" &&
    parts[1] === "32768" &&
    parts[2] === "8" &&
    parts[3] === "1" &&
    /^[0-9a-f]{64}$/.test(parts[4]!) &&
    /^[0-9a-f]{128}$/.test(parts[5]!);
  const salt = valid ? Buffer.from(parts![4]!, "hex") : Buffer.alloc(32);
  const key = await derive(password.slice(0, 1024), salt);
  return Boolean(valid && timingSafeEqual(key, Buffer.from(parts![5]!, "hex")));
}
