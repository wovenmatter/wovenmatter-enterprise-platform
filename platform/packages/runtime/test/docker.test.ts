import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, watch, type FSWatcher } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerRuntime,
  containerArguments,
  runNetwork,
  type DockerRuntimeOptions,
} from "../src/docker.ts";
import { validateHostRequest } from "../src/validation.ts";
import type { RuntimeRequest, RuntimeEvent } from "../src/types.ts";
import { storageVolumeName, volumeMount } from "../src/volumes.ts";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "wme-runtime-test-")),
  );
  const files = join(root, "files"),
    sessions = join(root, "sessions"),
    native = join(sessions, "conversation1");
  await mkdir(files);
  await mkdir(native, { recursive: true });
  const log = join(root, "commands.jsonl"),
    pid = join(root, "child.pid"),
    binary = join(root, "docker-fixture");
  const program = `#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const containerFile=${JSON.stringify(join(root, "container.json"))},networkFile=${JSON.stringify(join(root, "network.json"))};
const labels=()=>Object.fromEntries(a.flatMap((x,i)=>x==='--label'?[a[i+1].split('=')]:[]));
if(a[0]==='network' && a[1]==='create'){
 if(fs.existsSync(networkFile)){process.stderr.write('Error response from daemon: network with name '+a.at(-1)+' already exists');process.exit(1);}
 fs.writeFileSync(networkFile,JSON.stringify({Id:'d'.repeat(64),Name:a.at(-1),Internal:true,Labels:labels()}));
 if(fs.existsSync(${JSON.stringify(join(root, "uncertain-network"))})){process.stderr.write('Docker connection lost after request');process.exit(1);}
}
if(a[0]==='network' && a[1]==='inspect'){
 if(fs.existsSync(${JSON.stringify(join(root, "network-inspect-fails"))})){process.stderr.write('Daemon unavailable');process.exit(1);}
 if(!fs.existsSync(networkFile)){process.stderr.write('Error: No such network: '+a[2]);process.exit(1);}
 process.stdout.write('['+fs.readFileSync(networkFile,'utf8')+']');
}
if(a[0]==='container' && a[1]==='inspect'){
 if(!fs.existsSync(containerFile)){process.stderr.write('Error: No such container: '+a[2]);process.exit(1);}
 process.stdout.write('['+fs.readFileSync(containerFile,'utf8')+']');
}
if(a[0]==='network' && a[1]==='rm' && fs.existsSync(networkFile))fs.unlinkSync(networkFile);
if(a[0]==='rm' && fs.existsSync(${JSON.stringify(join(root, "remove-fails-once"))})){fs.unlinkSync(${JSON.stringify(join(root, "remove-fails-once"))});process.stderr.write('Daemon unavailable during cleanup');process.exit(1);}
if(a[0]==='rm' && fs.existsSync(containerFile))fs.unlinkSync(containerFile);

if(a[0]==='volume' && a[1]==='inspect'){const roots=${JSON.stringify([files, sessions])};const crypto=await import('node:crypto');const root=roots.find(r=>'wme-storage-'+crypto.createHash('sha256').update(r).digest('hex').slice(0,32)===a[2]);process.stdout.write(JSON.stringify([{Driver:'local',Options:{type:'none',o:'bind',device:root}}]));}
if(a[0]==='create' && fs.existsSync(${JSON.stringify(join(root, "block-create"))})) {
 await new Promise((resolve,reject)=>{
  const release=${JSON.stringify(join(root, "release-create"))};
  const check=()=>{if(fs.existsSync(release)){observer.close();resolve();}};
  const observer=fs.watch(${JSON.stringify(root)},check);
  observer.once('error',reject);
  fs.writeFileSync(${JSON.stringify(join(root, "create-entered"))},'yes');
  check();
 });
}
if(a[0]==='create')fs.writeFileSync(containerFile,JSON.stringify({Id:'c'.repeat(64),Name:'/'+a[a.indexOf('--name')+1],Config:{Labels:labels()}}));
if(a[0]==='start'){
 fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));let data='';for await(const c of process.stdin)data+=c;
 const r=JSON.parse(data);fs.writeFileSync(${JSON.stringify(join(root, "request.json"))},JSON.stringify(r));process.stdout.write(JSON.stringify({type:'started'})+'\\n');
 if(r.prompt==='wait'){await new Promise(r=>setTimeout(r,10000));}
 else if(r.prompt==='malformed'){process.stdout.write('not json\\n');await new Promise(r=>setTimeout(r,10000));}
 else {process.stdout.write(JSON.stringify({type:'assistant_delta',delta:'fixture result'})+'\\n');process.stdout.write(JSON.stringify({type:'completed'})+'\\n');}
}
if(a[0]==='rm' && fs.existsSync(${JSON.stringify(pid)})){try{process.kill(Number(fs.readFileSync(${JSON.stringify(pid)},'utf8')),'SIGTERM')}catch{};fs.unlinkSync(${JSON.stringify(pid)});}
`;
  await writeFile(binary, program);
  await chmod(binary, 0o700);
  const options: DockerRuntimeOptions = {
    image: "wme-runtime:fixture",
    network: "wme-runtime",
    networkPool: "10.252.0.0/24",
    gatewayContainer: "wme-api",
    storageRoots: [files],
    sessionRoot: sessions,
    journalRoot: join(root, "journal"),
    gatewayOrigins: ["http://api:4100"],
    dockerBinary: binary,
    appArmorProfile: "wme-platform-agent",
    timeoutMs: 5000,
    pinMounts: async () => ({ evidence: [], async close() {} }),
  };
  const request: RuntimeRequest = {
    runId: "run1",
    organizationId: "org1",
    projectId: "project1",
    conversationId: "conversation1",
    harness: "codex",
    model: "fixture-model",
    prompt: "hello",
    access: "read",
    mounts: [{ source: files, target: "/workspace", access: "write" }],
    sessionDirectory: native,
    gateway: {
      baseUrl: "http://api:4100/api/runtime/inference/project1",
      token: "synthetic-scoped-token-only",
    },
  };
  return {
    root,
    options,
    request,
    log,
    async commands(): Promise<string[][]> {
      return (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("container policy limits every mount and exposes no platform secret or socket", async () => {
  const f = await fixture();
  try {
    const args = containerArguments(f.request, f.options);
    for (const required of [
      "--read-only",
      "--cap-drop",
      "ALL",
      "no-new-privileges:true",
      "apparmor=wme-platform-agent",
      "--pids-limit",
      "--memory",
      "--cpus",
    ])
      assert.ok(args.includes(required));
    const workspace = args.find((a) => a.includes("dst=/workspace"))!;
    assert.ok(workspace.endsWith(",readonly"));
    assert.ok(!args.join(" ").includes(f.request.gateway.token));
    assert.ok(!args.join(" ").includes("docker.sock"));
    assert.notEqual(
      runNetwork("run1", "wme-runtime"),
      runNetwork("run2", "wme-runtime"),
    );
    assert.equal(args[0], "create");
    assert.ok(workspace.includes("volume-subpath=."));
    assert.ok(!workspace.includes("type=bind"));
  } finally {
    await f.cleanup();
  }
});
test("subpath mounts anchor source to immutable storage volume and reject host escapes", () => {
  const mount = volumeMount(
    "/srv/workspaces/organizations/org1/files/shared.pdf",
    "/workspace/Shared.pdf",
    ["/srv/workspaces"],
    true,
  );
  assert.ok(mount.includes("src=" + storageVolumeName("/srv/workspaces")));
  assert.ok(
    mount.includes("volume-subpath=organizations/org1/files/shared.pdf"),
  );
  assert.ok(mount.endsWith(",readonly"));
  assert.throws(() =>
    volumeMount("/etc/passwd", "/workspace/Escape", ["/srv/workspaces"], false),
  );
});
test("full access still respects a read-only organization share", async () => {
  const f = await fixture();
  try {
    const request = {
      ...f.request,
      access: "write" as const,
      mounts: [
        ...f.request.mounts,
        {
          source: f.request.mounts[0].source,
          target: "/workspace/Shared",
          access: "read" as const,
        },
      ],
    };
    const args = containerArguments(request, f.options);
    assert.ok(
      !args.find((a) => a.includes("dst=/workspace,"))!.endsWith(",readonly"),
    );
    assert.ok(
      args
        .find((a) => a.includes("dst=/workspace/Shared"))!
        .endsWith(",readonly"),
    );
  } finally {
    await f.cleanup();
  }
});
test("source escape, symlink sources, control-plane session mount, and target traversal fail", async () => {
  const f = await fixture();
  try {
    await symlink(f.request.mounts[0].source, join(f.root, "link"));
    for (const source of ["/etc", join(f.root, "link")])
      await assert.rejects(
        validateHostRequest(
          {
            ...f.request,
            mounts: [{ source, target: "/workspace", access: "read" }],
          },
          f.options.storageRoots,
          f.options.sessionRoot,
        ),
      );
    await assert.rejects(
      validateHostRequest(
        {
          ...f.request,
          mounts: [{ ...f.request.mounts[0], target: "/workspace/../../etc" }],
        },
        f.options.storageRoots,
        f.options.sessionRoot,
      ),
      /target/,
    );
    await assert.rejects(
      validateHostRequest(
        { ...f.request, sessionDirectory: f.request.mounts[0].source },
        f.options.storageRoots,
        f.options.sessionRoot,
      ),
      /session storage/,
    );
  } finally {
    await f.cleanup();
  }
});
test("execution persists receipt, streams in order, cleans private network, and rejects replay", async () => {
  const f = await fixture();
  try {
    const runtime = new DockerRuntime(f.options),
      events: RuntimeEvent[] = [];
    await runtime.execute(f.request, async (e) => {
      if (e.type === "completed")
        assert.ok((await f.commands()).some((c) => c[0] === "rm"));
      events.push(e);
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ["started", "assistant_delta", "completed"],
    );
    assert.equal(
      JSON.parse(
        await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
      ).status,
      "completed",
    );
    await assert.rejects(
      runtime.execute(f.request, () => {}),
      /already been dispatched/,
    );
    const commands = await f.commands();
    assert.equal(commands.filter((c) => c[0] === "start").length, 1);
    assert.ok(
      commands.some(
        (c) =>
          c[0] === "network" &&
          c[1] === "create" &&
          c.includes("--internal") &&
          c.includes("--subnet") &&
          /^10\.252\.0\.\d+\/28$/.test(c[c.indexOf("--subnet") + 1]),
      ),
    );
    assert.ok(
      commands.some((c) => c[0] === "network" && c[1] === "disconnect"),
    );
    assert.ok(commands.some((c) => c[0] === "network" && c[1] === "rm"));
  } finally {
    await f.cleanup();
  }
});
test("egress requires supervisor allowlist and forwards only the credential-free origin", async () => {
  const f = await fixture();
  try {
    const request = { ...f.request, egressProxyUrl: "http://api:4101" };
    await assert.rejects(
      new DockerRuntime(f.options).execute(request, () => {}),
      /egress proxy is not allowed/,
    );
    await assert.rejects(
      new DockerRuntime({
        ...f.options,
        egressProxyOrigins: ["http://api:4102"],
      }).execute(request, () => {}),
      /egress proxy is not allowed/,
    );
    await assert.rejects(readFile(f.log), { code: "ENOENT" });
    const runtime = new DockerRuntime({
      ...f.options,
      egressProxyOrigins: ["http://api:4101"],
    });
    await runtime.execute(request, () => {});
    const payload = JSON.parse(
      await readFile(join(f.root, "request.json"), "utf8"),
    );
    assert.equal(payload.egressProxyUrl, "http://api:4101");
    assert.ok(!payload.egressProxyUrl.includes(request.gateway.token));
    assert.ok(
      (await f.commands()).some(
        (command) =>
          command[0] === "network" &&
          command[1] === "create" &&
          command.includes("--internal"),
      ),
    );
  } finally {
    await f.cleanup();
  }
});
test("cancellation during container creation never launches agent work", async () => {
  const f = await fixture(),
    abort = new AbortController();
  let observer: FSWatcher | undefined;
  let active: Promise<void> | undefined;
  const release = () => writeFile(join(f.root, "release-create"), "yes");
  try {
    await writeFile(join(f.root, "block-create"), "yes");
    const createEntered = new Promise<void>((resolve, reject) => {
      observer = watch(f.root, () => {
        if (existsSync(join(f.root, "create-entered"))) {
          observer?.close();
          resolve();
        }
      });
      observer.once("error", reject);
    });
    const runtime = new DockerRuntime(f.options),
      events: RuntimeEvent[] = [];
    active = runtime.execute(
      f.request,
      (event) => {
        events.push(event);
      },
      abort.signal,
    );
    // The fake Docker command is held inside create until cancellation is issued.
    // Register the watcher before dispatch so neither process scheduling nor slow
    // preflight can move the cancellation into an earlier phase of execution.
    await Promise.race([
      createEntered,
      active.then(() => {
        throw new Error("Runtime finished before entering container creation");
      }),
    ]);
    assert.ok((await f.commands()).some((command) => command[0] === "create"));
    abort.abort();
    await release();
    await active;
    assert.deepEqual(events, [{ type: "cancelled" }]);
    const commands = await f.commands();
    assert.ok(!commands.some((command) => command[0] === "start"));
    assert.ok(commands.some((command) => command[0] === "rm"));
    assert.ok(
      commands.some(
        (command) => command[0] === "network" && command[1] === "rm",
      ),
    );
  } finally {
    observer?.close();
    abort.abort();
    await release();
    await active?.catch(() => {});
    await f.cleanup();
  }
});

test("cancel stops a running process and marks its single-use receipt", async () => {
  const f = await fixture();
  try {
    const runtime = new DockerRuntime(f.options),
      events: RuntimeEvent[] = [],
      abort = new AbortController();
    await runtime.execute(
      { ...f.request, prompt: "wait" },
      (e) => {
        events.push(e);
        if (e.type === "started") abort.abort();
      },
      abort.signal,
    );
    assert.equal(events.at(-1)?.type, "cancelled");
    assert.equal(
      JSON.parse(
        await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
      ).status,
      "cancelled",
    );
  } finally {
    await f.cleanup();
  }
});
test("malformed output force-stops the agent before emitting failure", async () => {
  const f = await fixture();
  try {
    const runtime = new DockerRuntime(f.options),
      events: RuntimeEvent[] = [];
    await runtime.execute({ ...f.request, prompt: "malformed" }, async (e) => {
      if (e.type === "failed")
        assert.ok((await f.commands()).some((c) => c[0] === "rm"));
      events.push(e);
    });
    assert.equal(events.at(-1)?.type, "failed");
    assert.ok(!events.some((e) => e.type === "completed"));
  } finally {
    await f.cleanup();
  }
});
test("recovery terminates uncertain work and never resubmits a prompt", async () => {
  const f = await fixture();
  try {
    await mkdir(f.options.journalRoot);
    await writeFile(
      join(f.options.journalRoot, "run1.json"),
      JSON.stringify({
        runId: "run1",
        allocationId: "recovery-fixture",
        conversationId: "conversation1",
        status: "dispatching",
        updatedAt: new Date().toISOString(),
      }),
    );
    const labels = {
      "com.wovenmatter.enterprise.runtime": "true",
      "com.wovenmatter.enterprise.run": "run1",
      "com.wovenmatter.enterprise.allocation": "recovery-fixture",
    };
    await writeFile(
      join(f.root, "container.json"),
      JSON.stringify({
        Id: "c".repeat(64),
        Name: "/wme-run-run1",
        Config: { Labels: labels },
      }),
    );
    await writeFile(
      join(f.root, "network.json"),
      JSON.stringify({
        Id: "d".repeat(64),
        Name: runNetwork("run1", f.options.network),
        Internal: true,
        Labels: labels,
      }),
    );
    const runtime = new DockerRuntime(f.options);
    assert.deepEqual(await runtime.recover(), ["run1"]);
    assert.deepEqual(await runtime.recover(), []);
    assert.ok(
      !(await f.commands()).some((c) => ["create", "start"].includes(c[0])),
    );
    assert.equal(
      JSON.parse(
        await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
      ).status,
      "interrupted",
    );
  } finally {
    await f.cleanup();
  }
});

test("runtime requires an explicit valid network pool before Docker operations", async () => {
  const f = await fixture();
  try {
    for (const networkPool of [undefined, "", "8.8.0.0/16", "10.252.0.1/24"])
      assert.throws(
        () =>
          new DockerRuntime({
            ...f.options,
            networkPool: networkPool as string,
          }),
        /network pool/,
      );
    await assert.rejects(readFile(f.log), { code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("ambiguous network creation is cleaned by its durable allocation labels", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "uncertain-network"), "yes");
    const runtime = new DockerRuntime(f.options),
      events: RuntimeEvent[] = [];
    await runtime.execute(f.request, (event) => {
      events.push(event);
    });
    assert.equal(events.at(-1)?.type, "failed");
    const receipt = JSON.parse(
      await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
    );
    assert.equal(typeof receipt.allocationId, "string");
    assert.equal(receipt.status, "failed");
    const commands = await f.commands();
    assert.ok(
      commands.some(
        (args) =>
          args[0] === "network" &&
          args[1] === "rm" &&
          args[2] === "d".repeat(64),
      ),
    );
    assert.ok(
      !commands.some((args) => args[0] === "create" || args[0] === "start"),
    );
    await assert.rejects(readFile(join(f.root, "network.json")), {
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("uncertain cleanup retains its receipt and recovery removes only that allocation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "uncertain-network"), "yes");
    await writeFile(join(f.root, "network-inspect-fails"), "yes");
    const runtime = new DockerRuntime(f.options);
    await assert.rejects(runtime.execute(f.request, () => {}));
    const receipt = JSON.parse(
      await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
    );
    assert.equal(receipt.status, "dispatching");
    await rm(join(f.root, "network-inspect-fails"));
    assert.deepEqual(await runtime.recover(), ["run1"]);
    await assert.rejects(readFile(join(f.root, "network.json")), {
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("creation collisions and later recovery never delete a preexisting foreign network", async () => {
  const f = await fixture();
  try {
    const foreign = {
      Id: "e".repeat(64),
      Name: runNetwork("run1", f.options.network),
      Internal: true,
      Labels: {
        "com.wovenmatter.enterprise.runtime": "true",
        "com.wovenmatter.enterprise.run": "run1",
        "com.wovenmatter.enterprise.allocation": "someone-elses-allocation",
      },
    };
    await writeFile(join(f.root, "network.json"), JSON.stringify(foreign));
    const runtime = new DockerRuntime(f.options);
    await assert.rejects(
      runtime.execute(f.request, () => {}),
      /ownership/,
    );
    await assert.rejects(runtime.recover(), /ownership/);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.root, "network.json"), "utf8")),
      foreign,
    );
    assert.ok(
      !(await f.commands()).some(
        (args) =>
          args[0] === "rm" ||
          (args[0] === "network" && ["rm", "disconnect"].includes(args[1])),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("recovery refuses foreign containers and legacy allocations before any deletion", async () => {
  for (const legacy of [false, true]) {
    const f = await fixture();
    try {
      await mkdir(f.options.journalRoot);
      await writeFile(
        join(f.options.journalRoot, "run1.json"),
        JSON.stringify({
          runId: "run1",
          conversationId: "conversation1",
          status: "dispatching",
          ...(legacy ? {} : { allocationId: "expected-attempt" }),
          updatedAt: new Date().toISOString(),
        }),
      );
      const container = {
        Id: "f".repeat(64),
        Name: "/wme-run-run1",
        Config: {
          Labels: {
            "com.wovenmatter.enterprise.runtime": "true",
            "com.wovenmatter.enterprise.run": "run1",
            ...(legacy
              ? {}
              : { "com.wovenmatter.enterprise.allocation": "foreign-attempt" }),
          },
        },
      };
      await writeFile(
        join(f.root, "container.json"),
        JSON.stringify(container),
      );
      await assert.rejects(new DockerRuntime(f.options).recover(), /ownership/);
      assert.deepEqual(
        JSON.parse(await readFile(join(f.root, "container.json"), "utf8")),
        container,
      );
      assert.ok(
        !(await f.commands()).some(
          (args) =>
            args[0] === "rm" ||
            (args[0] === "network" && ["rm", "disconnect"].includes(args[1])),
        ),
      );
      assert.equal(
        JSON.parse(
          await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
        ).status,
        "dispatching",
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("legacy interrupted receipts without remaining Docker resources can complete recovery", async () => {
  const f = await fixture();
  try {
    await mkdir(f.options.journalRoot);
    await writeFile(
      join(f.options.journalRoot, "run1.json"),
      JSON.stringify({
        runId: "run1",
        conversationId: "conversation1",
        status: "dispatching",
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.deepEqual(await new DockerRuntime(f.options).recover(), ["run1"]);
    assert.ok(
      !(await f.commands()).some(
        (args) =>
          args[0] === "rm" ||
          (args[0] === "network" && ["rm", "disconnect"].includes(args[1])),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("cancel reloads durable ownership after execute cleanup fails and clears active state", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "remove-fails-once"), "yes");
    const runtime = new DockerRuntime(f.options),
      events: RuntimeEvent[] = [];
    await assert.rejects(
      runtime.execute(f.request, (event) => {
        events.push(event);
      }),
    );
    assert.ok(
      !events.some((event) =>
        ["completed", "cancelled", "failed"].includes(event.type),
      ),
    );
    const receipt = JSON.parse(
      await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
    );
    assert.equal(receipt.status, "dispatching");
    const retained = JSON.parse(
      await readFile(join(f.root, "container.json"), "utf8"),
    );
    assert.equal(
      retained.Config.Labels["com.wovenmatter.enterprise.allocation"],
      receipt.allocationId,
    );
    const before = (await f.commands()).length;
    await runtime.cancel("run1");
    const retryCommands = (await f.commands()).slice(before);
    assert.ok(
      retryCommands.some(
        (args) => args[0] === "container" && args[1] === "inspect",
      ),
    );
    assert.ok(
      retryCommands.some((args) => args[0] === "rm" && args[2] === retained.Id),
    );
    await assert.rejects(readFile(join(f.root, "container.json")), {
      code: "ENOENT",
    });
    assert.equal(
      JSON.parse(
        await readFile(join(f.options.journalRoot, "run1.json"), "utf8"),
      ).status,
      "dispatching",
    );
    assert.deepEqual(await runtime.recover(), ["run1"]);
  } finally {
    await f.cleanup();
  }
});

test("cancel without active state fails closed on absent or invalid durable ownership", async () => {
  const f = await fixture();
  try {
    const container = {
      Id: "f".repeat(64),
      Name: "/wme-run-run1",
      Config: {
        Labels: {
          "com.wovenmatter.enterprise.runtime": "true",
          "com.wovenmatter.enterprise.run": "run1",
          "com.wovenmatter.enterprise.allocation": "unknown-owner",
        },
      },
    };
    await writeFile(join(f.root, "container.json"), JSON.stringify(container));
    const runtime = new DockerRuntime(f.options);
    await assert.rejects(runtime.cancel("run1"), /ownership/);
    await mkdir(f.options.journalRoot);
    for (const receipt of [
      { runId: "run1", status: "dispatching" },
      {
        runId: "wrong-run",
        status: "dispatching",
        allocationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      { runId: "run1", status: "dispatching", allocationId: "not-a-uuid" },
      {
        runId: "run1",
        status: "completed",
        allocationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ]) {
      await writeFile(
        join(f.options.journalRoot, "run1.json"),
        JSON.stringify(receipt),
      );
      await assert.rejects(runtime.cancel("run1"), /ownership|receipt/);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(f.root, "container.json"), "utf8")),
      container,
    );
    assert.ok(!(await f.commands()).some((args) => args[0] === "rm"));
    await rm(join(f.root, "container.json"));
    await runtime.cancel("run1"); // A finalized receipt plus confirmed absence can acknowledge.
    await rm(join(f.options.journalRoot, "run1.json"));
    await runtime.cancel("run1"); // Missing receipt also requires a real Docker absence check.
  } finally {
    await f.cleanup();
  }
});

test("ordinary Unicode and punctuation in shared names remain valid runtime mounts", async () => {
  const f = await fixture();
  try {
    const name = 'Résumé, "Q4" (2026).txt';
    const source = join(f.request.mounts[0].source, name);
    const target = `/workspace/${name}`;
    await writeFile(source, "shared document");
    await validateHostRequest(
      {
        ...f.request,
        mounts: [...f.request.mounts, { source, target, access: "read" }],
      },
      f.options.storageRoots,
      f.options.sessionRoot,
    );
    const mount = volumeMount(source, target, f.options.storageRoots, true);
    assert.ok(mount.includes('"dst=/workspace/Résumé, ""Q4"" (2026).txt"'));
    assert.ok(mount.includes('"volume-subpath=Résumé, ""Q4"" (2026).txt"'));
    assert.ok(mount.endsWith(",readonly"));
  } finally {
    await f.cleanup();
  }
});
