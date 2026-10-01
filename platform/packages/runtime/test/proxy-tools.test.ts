import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEgressEnvironment, egressEnvironment } from "../src/native.ts";
import type { ContainerRequest } from "../src/types.ts";

const exec = promisify(execFile);
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as { port: number }).port;
}

test(
  "curl, Git, Python, npm and Node use the scoped proxy; gateway traffic bypasses it",
  { timeout: 60000 },
  async () => {
    // This server never forwards traffic. The .invalid destination cannot resolve;
    // every response is synthesized locally and no real provider/account is used.
    const requests: { target: string; authorization: string | undefined }[] =
      [];
    const sockets = new Set<Socket>();
    const expectedAuthorization =
      "Basic " +
      Buffer.from("fixture-project:synthetic-scoped-fixture-token").toString(
        "base64",
      );
    const gitId = "a".repeat(40);
    const packet = (line: string) =>
      (Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line;
    function response(target: string) {
      if (target.includes("/repo"))
        return {
          type: "application/x-git-upload-pack-advertisement",
          body:
            packet("# service=git-upload-pack\n") +
            "0000" +
            packet(`${gitId} HEAD\0symref=HEAD:refs/heads/main\n`) +
            packet(`${gitId} refs/heads/main\n`) +
            "0000",
        };
      if (target.includes("/fixture-package"))
        return {
          type: "application/json",
          body: JSON.stringify({
            name: "fixture-package",
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": { name: "fixture-package", version: "1.0.0" },
            },
          }),
        };
      return { type: "text/plain", body: "proxy-fixture" };
    }
    const proxy = createServer((request, result) => {
      requests.push({
        target: request.url!,
        authorization: request.headers["proxy-authorization"],
      });
      if (request.headers["proxy-authorization"] !== expectedAuthorization) {
        result.writeHead(407, {
          "proxy-authenticate": 'Basic realm="synthetic-fixture"',
        });
        result.end();
        return;
      }
      const output = response(request.url!);
      result.writeHead(200, { "content-type": output.type });
      result.end(output.body);
    });
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (request, socket) => {
      requests.push({
        target: request.url!,
        authorization: request.headers["proxy-authorization"],
      });
      if (request.headers["proxy-authorization"] !== expectedAuthorization) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="synthetic-fixture"\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (data) => {
        const target = data.toString().split(" ")[1];
        const output = response(target);
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: ${output.type}\r\nContent-Length: ${Buffer.byteLength(output.body)}\r\nConnection: close\r\n\r\n${output.body}`,
        );
      });
    });
    let gatewayRequests = 0;
    const gateway = createServer((request, result) => {
      assert.equal(request.headers["proxy-authorization"], undefined);
      gatewayRequests++;
      result.end("gateway-fixture");
    });
    const home = await mkdtemp(join(tmpdir(), "wme-proxy-tools-"));
    let restore = () => {};
    try {
      const proxyPort = await listen(proxy),
        gatewayPort = await listen(gateway);
      const request: ContainerRequest = {
        runId: "fixture-run",
        projectId: "fixture-project",
        harness: "pi",
        model: "fixture-model",
        prompt: "Synthetic test",
        access: "read",
        gateway: {
          baseUrl: `http://127.0.0.1:${gatewayPort}`,
          token: "synthetic-scoped-fixture-token",
        },
        egressProxyUrl: `http://127.0.0.1:${proxyPort}`,
      };
      const environment = {
        PATH: process.env.PATH!,
        HOME: home,
        TMPDIR: home,
        ...egressEnvironment(request),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        NO_UPDATE_NOTIFIER: "1",
        npm_config_update_notifier: "false",
      };
      const commands: [string, string[], string][] = [
        [
          "curl",
          [
            "--fail",
            "--silent",
            "--show-error",
            "http://public-fixture.invalid/text",
          ],
          "proxy-fixture",
        ],
        [
          "git",
          [
            "-c",
            "credential.helper=",
            "-c",
            "protocol.version=0",
            "ls-remote",
            "http://public-fixture.invalid/repo",
          ],
          `${gitId}\tHEAD\n${gitId}\trefs/heads/main`,
        ],
        [
          "python3",
          [
            "-c",
            "from urllib.request import urlopen; print(urlopen('http://public-fixture.invalid/text', timeout=5).read().decode())",
          ],
          "proxy-fixture",
        ],
        [
          "npm",
          [
            "view",
            "fixture-package",
            "version",
            "--registry=http://public-fixture.invalid",
            "--fetch-retries=0",
          ],
          "1.0.0",
        ],
        [
          process.execPath,
          [
            "-e",
            "fetch('http://public-fixture.invalid/text').then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exit(1)})",
          ],
          "proxy-fixture",
        ],
      ];
      for (const [command, args, expected] of commands) {
        const before = requests.length;
        const result = await exec(command, args, {
          env: environment,
          cwd: home,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });
        assert.equal(result.stdout.trim(), expected, command);
        assert.ok(requests.length > before, `${command} did not use the proxy`);
      }
      restore = applyEgressEnvironment(request);
      assert.equal(
        await (await fetch("http://public-fixture.invalid/text")).text(),
        "proxy-fixture",
      );
      const before = requests.length;
      assert.equal(
        await (await fetch(request.gateway.baseUrl)).text(),
        "gateway-fixture",
      );
      assert.equal(requests.length, before);
      assert.equal(gatewayRequests, 1);
      for (const observed of requests)
        assert.ok(
          observed.authorization === undefined ||
            observed.authorization === expectedAuthorization,
        );
    } finally {
      restore();
      for (const socket of sockets) socket.destroy();
      proxy.closeAllConnections();
      gateway.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => gateway.close(() => resolve())),
      ]);
      await rm(home, { recursive: true, force: true });
    }
  },
);
