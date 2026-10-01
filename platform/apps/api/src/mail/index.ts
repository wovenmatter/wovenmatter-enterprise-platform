import { readFile } from "node:fs/promises";
import nodemailer from "nodemailer";

export interface MailConfig {
  host: string;
  name?: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  passwordFile?: string;
  requireTLS?: boolean;
}
/** Only account invitations. The application never accepts arbitrary message bodies/recipients here. */
export async function sendInvitation(
  config: MailConfig,
  invitation: { email: string; name: string; activationUrl: string },
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Delivery cancelled");
  if (!config.host || !config.from)
    throw new Error("Account email delivery is not configured");
  const url = new URL(invitation.activationUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid activation URL");
  if (/\r|\n/.test(invitation.email) || /\r|\n/.test(config.from))
    throw new Error("Invalid email address");
  const pass = config.passwordFile
    ? (await readFile(config.passwordFile, "utf8")).trim()
    : undefined;
  const transport = nodemailer.createTransport({
    host: config.host,
    name: config.name,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS !== false,
    auth: config.user && pass ? { user: config.user, pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const abort = () => transport.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await transport.sendMail({
      from: config.from,
      to: invitation.email,
      subject: "Your WovenMatter Enterprise Platform invitation",
      text: `You have been invited to WovenMatter Enterprise Platform.\n\nCreate your account using this private invitation link:\n${url.href}\n\nIf you did not expect this invitation, you can ignore this message.`,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    transport.close();
  }
}
export async function sendPasswordReset(
  config: MailConfig,
  reset: { email: string; name: string; resetUrl: string },
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Delivery cancelled");
  if (!config.host || !config.from)
    throw new Error("Account email delivery is not configured");
  const url = new URL(reset.resetUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid reset URL");
  if (/\r|\n/.test(reset.email) || /\r|\n/.test(config.from))
    throw new Error("Invalid email address");
  const pass = config.passwordFile
    ? (await readFile(config.passwordFile, "utf8")).trim()
    : undefined;
  const transport = nodemailer.createTransport({
    host: config.host,
    name: config.name,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS !== false,
    auth: config.user && pass ? { user: config.user, pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const abort = () => transport.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await transport.sendMail({
      from: config.from,
      to: reset.email,
      subject: "Reset your WovenMatter Enterprise Platform password",
      text: `A password reset was requested for your WovenMatter Enterprise Platform account.\n\nComplete the reset using this private link:\n${url.href}\n\nIf you did not request this, you can ignore this message.`,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    transport.close();
  }
}
export function mailConfigFromEnvironment(
  env: NodeJS.ProcessEnv,
): MailConfig | undefined {
  if (!env.WME_SMTP_HOST || !env.WME_SMTP_FROM) return undefined;
  const port = Number(env.WME_SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid SMTP port");
  return {
    host: env.WME_SMTP_HOST,
    name: env.WME_SMTP_NAME,
    port,
    from: env.WME_SMTP_FROM,
    secure: port === 465,
    requireTLS: true,
    user: env.WME_SMTP_USER,
    passwordFile: env.WME_SMTP_PASSWORD_FILE,
  };
}
