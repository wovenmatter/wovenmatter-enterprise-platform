/** Runs a project-owned shell script with the same kernel boundary as thread tools. */
import { spawn } from "node:child_process";
import { assertIsolation, proxy } from "./process-boundary.js";
import { verifyMountEvidence } from "./mount-evidence.js";
import { egressEnvironment } from "./native.js";
import { safeRelative } from "./sandbox.js";
await assertIsolation();
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 65536) throw new Error("Schedule request too large");
}
const request = JSON.parse(input);
await verifyMountEvidence(request.mountEvidence);
const script = safeRelative(request.script);
const close = request.egressToken
  ? await proxy(4102, "/broker/egress.sock")
  : () => {};
const env = request.egressToken
  ? egressEnvironment({
      projectId: request.projectId,
      gateway: {
        baseUrl: "http://127.0.0.1:4101/unavailable",
        token: request.egressToken,
      },
      egressProxyUrl: "http://127.0.0.1:4102",
    } as any)
  : {};
try {
  const child = spawn("/bin/sh", [`/workspace/${script}`, ...request.args], {
    cwd: "/workspace",
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
} finally {
  close();
}
