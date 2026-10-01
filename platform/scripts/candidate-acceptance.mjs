// Explicit isolated-candidate acceptance. Creates synthetic tenants, never provider logins.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
if (
  process.env.WME_RUN_CANDIDATE_ACCEPTANCE !== "1" ||
  !process.env.WME_STATE_DIR?.includes("candidate")
)
  throw new Error("Explicit isolated candidate state is required");
const state = process.env.WME_STATE_DIR,
  origin = process.env.WME_PUBLIC_ORIGIN,
  portalHost = new URL(origin).host;
const db = new DatabaseSync(join(state, "control/platform.sqlite"));
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
const orgId = randomUUID(),
  adminId = randomUUID(),
  outsideOrg = randomUUID(),
  outsideId = randomUUID();
const now = new Date().toISOString(),
  expires = new Date(Date.now() + 3600_000).toISOString();
const token = randomBytes(32).toString("hex"),
  outsideToken = randomBytes(32).toString("hex"),
  csrf = randomBytes(32).toString("hex");
db.prepare("INSERT INTO organizations VALUES (?,?,?)").run(
  orgId,
  "Container acceptance",
  now,
);
db.prepare("INSERT INTO organizations VALUES (?,?,?)").run(
  outsideOrg,
  "Unrelated tenant",
  now,
);
for (const [id, org, email] of [
  [adminId, orgId, `${adminId}@acceptance.invalid`],
  [outsideId, outsideOrg, `${outsideId}@acceptance.invalid`],
])
  db.prepare(
    "INSERT INTO users(id,org_id,email,name,role,enabled,created_at) VALUES(?,?,?,'Acceptance administrator','admin',1,?)",
  ).run(id, org, email, now);
for (const [id, secret] of [
  [adminId, token],
  [outsideId, outsideToken],
])
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(
    createHash("sha256").update(secret).digest("hex"),
    id,
    csrf,
    expires,
    now,
  );
db.close();
const portalCookie = `__Host-wme_session=${token}`,
  foreignCookie = `__Host-wme_session=${outsideToken}`;
async function call(
  path,
  {
    method = "GET",
    host = portalHost,
    cookie = portalCookie,
    body,
    requestOrigin = origin,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 4100,
        path,
        method,
        headers: {
          host,
          ...(cookie ? { cookie } : {}),
          origin: requestOrigin,
          "x-csrf-token": csrf,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024)
            res.destroy(new Error("Response too large"));
        });
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on("error", reject);
      },
    );
    req.once("error", reject);
    req.setTimeout(120_000, () =>
      req.destroy(new Error("Acceptance request timed out")),
    );
    req.end(payload);
  });
}
function ok(result) {
  assert.ok(
    result.status >= 200 && result.status < 300,
    `HTTP ${result.status}: ${result.text}`,
  );
  return result.json;
}
async function grant(share, cookie = "") {
  const entry = await call(new URL(share.url).pathname, { cookie });
  assert.equal(entry.status, 302);
  const redirect = new URL(entry.headers.location);
  assert.match(redirect.pathname, /^\/_wme\/exchange/);
  const exchange = await call(redirect.pathname + redirect.search, {
    host: redirect.host,
    cookie: "",
  });
  assert.equal(exchange.status, 302);
  return {
    host: redirect.host,
    cookie: exchange.headers["set-cookie"]
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}
const liveSource = `import http from 'node:http';import{DatabaseSync}from'node:sqlite';import{createHash}from'node:crypto';const db=new DatabaseSync('/data/counter.sqlite');db.exec('CREATE TABLE IF NOT EXISTS counts(value INTEGER);INSERT INTO counts SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM counts)');const s=http.createServer((q,r)=>{if(q.url==='/increment')db.exec('UPDATE counts SET value=value+1');r.setHeader('content-type','application/json');r.setHeader('set-cookie',['dashboard_session=ok; Domain=candidate.test; Path=/','__Host-wme_asset=forbidden; Path=/']);r.end(JSON.stringify({count:db.prepare('SELECT value FROM counts').get().value,cookie:q.headers.cookie??'',path:q.url}));});s.on('upgrade',(q,c)=>{const accept=createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');c.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\nSet-Cookie: __Host-wme_session=bad; Domain=candidate.test\\r\\nSet-Cookie: dashboard_ws=ok; Domain=candidate.test\\r\\n\\r\\n');c.on('data',b=>{if(b.length<6)return;const length=b[1]&127;const value=Buffer.from(b.subarray(6,6+length));for(let i=0;i<value.length;i++)value[i]^=b[2+(i%4)];c.write(Buffer.concat([Buffer.from([129,value.length]),value]));});});s.listen(Number(process.env.PORT),'0.0.0.0');`;
try {
  ok(await call("/healthz"));
  assert.equal(
    (await call("/api/session", { host: "untrusted.example" })).status,
    404,
  );
  const asset = ok(
    await call(`/api/organizations/${orgId}/assets`, {
      method: "POST",
      body: { name: "Live container acceptance", type: "live" },
    }),
  );
  const bundle = {
    expectedVersionId: null,
    entrypoint: "server.mjs",
    files: [
      {
        path: "server.mjs",
        contentBase64: Buffer.from(liveSource).toString("base64"),
      },
    ],
  };
  const published = ok(
    await call(`/api/assets/${asset.id}/publish`, {
      method: "POST",
      body: bundle,
    }),
  );
  assert.equal(published.version.runtimeStatus, "running");
  const share = ok(
    await call(`/api/assets/${asset.id}/shares`, {
      method: "POST",
      body: { visibility: "public" },
    }),
  );
  const visitor = await grant(share);
  assert.equal(
    (await call("/", { host: visitor.host, cookie: "" })).status,
    401,
  );
  const first = await call("/increment", { ...visitor });
  assert.equal(ok(first).count, 1);
  const cookies = first.headers["set-cookie"] ?? [];
  assert.equal(cookies.length, 1);
  assert.ok(cookies[0].startsWith("dashboard_session="));
  assert.ok(!/domain=/i.test(cookies[0]));
  const ownCookie = await call("/", {
    ...visitor,
    cookie: visitor.cookie + "; dashboard_session=ok",
  });
  assert.equal(ok(ownCookie).cookie, "dashboard_session=ok");
  const second = ok(
    await call(`/api/assets/${asset.id}/publish`, {
      method: "POST",
      body: { ...bundle, expectedVersionId: published.version.id },
    }),
  );
  assert.equal(second.version.runtimeStatus, "running");
  assert.equal(ok(await call("/", visitor)).count, 1);
  for (const visibility of ["organization", "people"]) {
    const privateShare = ok(
      await call(`/api/assets/${asset.id}/shares`, {
        method: "POST",
        body: {
          visibility,
          ...(visibility === "people" ? { userIds: [adminId] } : {}),
        },
      }),
    );
    const anon = await call(new URL(privateShare.url).pathname, { cookie: "" });
    assert.equal(anon.status, 302);
    assert.ok(new URL(anon.headers.location).searchParams.has("returnTo"));
    assert.equal(
      (
        await call(new URL(privateShare.url).pathname, {
          cookie: foreignCookie,
        })
      ).status,
      403,
    );
    const privateVisitor = await grant(privateShare, portalCookie);
    assert.equal(ok(await call("/", privateVisitor)).count, 1);
  }
  // Real WebSocket upgrade through API -> Unix supervisor -> isolated app.
  const websocket = await new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: 4100,
      path: "/socket",
      headers: {
        host: visitor.host,
        cookie: visitor.cookie,
        origin: `https://${visitor.host}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      res.resume();
      reject(new Error("WebSocket rejected " + res.statusCode));
    });
    req.on("upgrade", (res, socket) => {
      const set = res.headers["set-cookie"] ?? [];
      try {
        assert.equal(set.length, 1);
        assert.match(set[0], /^dashboard_ws=/);
        assert.ok(!/domain=/i.test(set[0]));
      } catch (error) {
        socket.destroy();
        reject(error);
        return;
      }
      resolve(socket);
    });
    req.setTimeout(10_000, () => req.destroy(new Error("WebSocket timeout")));
    req.end();
  });
  const echoed = new Promise((resolve, reject) => {
    websocket.once("data", (chunk) => resolve(chunk.subarray(2).toString()));
    websocket.once("error", reject);
  });
  const data = Buffer.from("hello"),
    mask = Buffer.from([1, 2, 3, 4]);
  const encoded = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
  websocket.write(
    Buffer.concat([Buffer.from([129, 128 + data.length]), mask, encoded]),
  );
  assert.equal(await echoed, "hello");
  const closed = new Promise((resolve) => websocket.once("close", resolve));
  ok(
    await call(`/api/assets/${asset.id}/shares/${share.share.id}`, {
      method: "DELETE",
    }),
  );
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Revoked WebSocket remained open")),
        3000,
      ),
    ),
  ]);
  assert.equal((await call("/", visitor)).status, 404);
  const staticAsset = ok(
    await call(`/api/organizations/${orgId}/assets`, {
      method: "POST",
      body: { name: "Static acceptance", type: "static" },
    }),
  );
  ok(
    await call(`/api/assets/${staticAsset.id}/publish`, {
      method: "POST",
      body: {
        expectedVersionId: null,
        files: [
          {
            path: "index.html",
            contentBase64: Buffer.from("<h1>Static acceptance</h1>").toString(
              "base64",
            ),
          },
        ],
      },
    }),
  );
  const staticShare = ok(
    await call(`/api/assets/${staticAsset.id}/shares`, {
      method: "POST",
      body: { visibility: "public" },
    }),
  );
  const staticVisitor = await grant(staticShare);
  assert.match((await call("/", staticVisitor)).text, /Static acceptance/);
  const { createSupervisorClient } = await import("../dist/deploy/client.js");
  const client = createSupervisorClient({
    socketPath: process.env.WME_SUPERVISOR_SOCKET,
    tokenFile: process.env.WME_SUPERVISOR_TOKEN_FILE,
  });
  const proxy = await client.registry.ensure(orgId);
  const models = await fetch(proxy.baseUrl + "/v1/models", {
    headers: { authorization: `Bearer ${proxy.clientKey}` },
  });
  assert.equal(models.status, 200);
  await models.body?.cancel();
  await writeFile(
    join(state, "acceptance-manifest.json"),
    JSON.stringify(
      {
        orgId,
        assetId: asset.id,
        staticAssetId: staticAsset.id,
        runtimeId: second.version.runtimeId,
        expectedCount: 1,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "Candidate acceptance passed: real live/static hosting, tenant/private/public gates, cookies, WebSocket echo/revocation, data persistence across publish, first-connect isolated proxy provisioning. No provider login or inference occurred.",
  );
} finally {
  const cleanup = new DatabaseSync(join(state, "control/platform.sqlite"));
  cleanup
    .prepare("DELETE FROM sessions WHERE user_id IN (?,?)")
    .run(adminId, outsideId);
  cleanup.close();
}
