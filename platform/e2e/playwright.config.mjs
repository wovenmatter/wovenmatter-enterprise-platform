import { defineConfig } from "@playwright/test";
const port = Number(process.env.WME_E2E_PORT ?? 4155);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("WME_E2E_PORT must be an unprivileged test port");
const origin = `http://localhost:${port}`;
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...(process.platform === "darwin" ? { channel: "chrome" } : {}),
    baseURL: origin,
    storageState: "platform/.state/e2e/auth.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1536, height: 1024 },
  },
  webServer: {
    command: "WME_E2E_FIXTURE=1 node platform/e2e/server.mjs",
    cwd: process.cwd(),
    url: `${origin}/healthz`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
