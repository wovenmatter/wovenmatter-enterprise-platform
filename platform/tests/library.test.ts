import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platformFixture } from "./fixtures/platform.js";
import {
  uploadFile,
  shareFile,
  revokeShare,
} from "../apps/api/src/files/service.js";
import { scopeRoot } from "../apps/api/src/files/paths.js";
import { validateReport } from "../apps/api/src/library/reports.js";
async function publish(
  f: Awaited<ReturnType<typeof platformFixture>>,
  document: unknown,
  visibility?: string,
) {
  return f.request(
    "full",
    "POST",
    `/enterprise/api/organizations/${f.orgA}/assets`,
    {
      projectId: f.projectA,
      name: "Team report",
      publish: true,
      document,
      ...(visibility
        ? {
            visibility,
          }
        : {}),
    },
  );
}
test("reports default to current project access; creator controls organization/public visibility and admin can override", async (t) => {
  const f = await platformFixture(t),
    a = await publish(f, {
      version: 1,
      blocks: [
        {
          type: "text",
          text: "Hello",
        },
      ],
    });
  assert.equal(a.statusCode, 201, a.body);
  const { id, url, visibility } = a.json();
  assert.equal(visibility, "project");
  assert.equal((await f.request(undefined, "GET", url)).statusCode, 401);
  assert.equal((await f.request("other", "GET", url)).statusCode, 404);
  assert.equal((await f.request("read", "GET", url)).statusCode, 200);
  await f.db.run(
    "DELETE FROM project_members WHERE project_id=? AND user_id=?",
    [f.projectA, f.users.read.id],
  );
  assert.equal((await f.request("read", "GET", url)).statusCode, 404);
  assert.equal(
    (
      await f.request("read", "PATCH", `/enterprise/api/assets/${id}`, {
        visibility: "public",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request("full", "PATCH", `/enterprise/api/assets/${id}`, {
        visibility: "organization",
      })
    ).statusCode,
    200,
  );
  assert.equal((await f.request("read", "GET", url)).statusCode, 200);
  await f.request("full", "PATCH", `/enterprise/api/assets/${id}`, {
    visibility: "public",
  });
  const publicPage = await f.request(undefined, "GET", url);
  assert.equal(publicPage.statusCode, 200);
  assert.match(
    String(publicPage.headers["content-security-policy"]),
    /sandbox;.*script-src 'none'/,
  );
  assert.equal(publicPage.headers["cache-control"], "no-store");
  assert.equal(publicPage.headers["set-cookie"], undefined);
  await f.request("admin", "PATCH", `/enterprise/api/assets/${id}`, {
    visibility: "project",
  });
  assert.equal((await f.request(undefined, "GET", url)).statusCode, 401);
});
test("each load projects only selected current data; raw JSON and arbitrary resources are never exposed", async (t) => {
  const f = await platformFixture(t),
    scope = {
      orgId: f.orgA,
      projectId: f.projectA,
    };
  const file = await uploadFile(
    f.ctx,
    f.users.full,
    scope,
    "data.json",
    Buffer.from(
      JSON.stringify({
        rows: [
          {
            name: "First",
            secret: "never publish",
            value: 5,
          },
        ],
      }),
    ),
  );
  const a = await publish(
    f,
    {
      version: 1,
      blocks: [
        {
          type: "table",
          fileId: file.id,
          pointer: "/rows",
          columns: [
            {
              label: "Name",
              key: "name",
            },
          ],
        },
        {
          type: "bars",
          fileId: file.id,
          pointer: "/rows",
          labelKey: "name",
          valueKey: "value",
          title: "Totals",
        },
      ],
    },
    "public",
  );
  assert.equal(a.statusCode, 201, a.body);
  const url = a.json().url;
  let page = await f.request(undefined, "GET", url);
  assert.match(page.body, /First/);
  assert.doesNotMatch(page.body, /never publish|secret/);
  assert.match(page.body, /<svg/);
  await uploadFile(
    f.ctx,
    f.users.full,
    scope,
    "data.json",
    Buffer.from(
      JSON.stringify({
        rows: [
          {
            name: "Updated <script>alert(1)</script>",
            secret: "still private",
            value: 10,
          },
        ],
      }),
    ),
  );
  page = await f.request(undefined, "GET", url);
  assert.match(page.body, /Updated &lt;script&gt;/);
  assert.doesNotMatch(page.body, /<script|still private/);
  for (const path of [
    "/data.json",
    "/document",
    "/images/0",
    "/images/..%2fdata.json",
  ])
    assert.equal(
      (await f.request(undefined, "GET", url + path)).statusCode,
      404,
    );
  assert.equal(
    (
      await f.request(
        undefined,
        "GET",
        `/enterprise/api/files/${file.id}/content`,
      )
    ).statusCode,
    401,
  );
});
test("safe contract rejects HTML, CSS, URL, scripts, executable live publishing and prototype paths", async (t) => {
  const f = await platformFixture(t);
  for (const document of [
    {
      version: 1,
      html: "<script/>",
      blocks: [
        {
          type: "text",
          text: "x",
        },
      ],
    },
    {
      version: 1,
      blocks: [
        {
          type: "html",
          text: "<img onerror=alert(1)>",
        },
      ],
    },
    {
      version: 1,
      blocks: [
        {
          type: "text",
          text: "x",
          style: "background:url(https://evil.test)",
        },
      ],
    },
    {
      version: 1,
      blocks: [
        {
          type: "image",
          fileId: "valid-id",
          alt: "x",
          url: "https://evil.test",
        },
      ],
    },
    {
      version: 1,
      blocks: [
        {
          type: "table",
          fileId: "valid-id",
          pointer: "/__proto__",
          columns: [
            {
              key: "secret",
              label: "x",
            },
          ],
        },
      ],
    },
  ])
    assert.throws(() => validateReport(document));
  assert.equal(
    (
      await f.request(
        "full",
        "POST",
        `/enterprise/api/organizations/${f.orgA}/assets`,
        {
          projectId: f.projectA,
          name: "live",
          type: "live",
          entrypoint: "server.mjs",
        },
      )
    ).statusCode,
    400,
  );
  const a = await publish(
    f,
    {
      version: 1,
      blocks: [
        {
          type: "text",
          text: '<form action="https://evil.test"><input></form><meta http-equiv="refresh">',
        },
        {
          type: "details",
          title: "<img src=x onerror=alert(1)>",
          text: "Safe",
        },
      ],
    },
    "public",
  );
  assert.equal(a.statusCode, 201, a.body);
  const page = await f.request(undefined, "GET", a.json().url);
  assert.doesNotMatch(page.body, /<form|<input|onerror="|http-equiv="/);
  assert.match(page.body, /&lt;form/);
  assert.equal(
    (
      await f.request(
        "full",
        "POST",
        `/enterprise/api/assets/${a.json().id}/publish`,
        {},
      )
    ).statusCode,
    409, // The restored publication route requires an explicit current draft revision.
  );
});
test("report sources cannot cross projects/organizations; library share revocation and creator removal revoke current data", async (t) => {
  const f = await platformFixture(t),
    other = await uploadFile(
      f.ctx,
      f.users.other,
      {
        orgId: f.orgB,
        projectId: f.projectB,
      },
      "data.json",
      Buffer.from("[]"),
    );
  assert.equal(
    (
      await publish(
        f,
        {
          version: 1,
          blocks: [
            {
              type: "table",
              fileId: other.id,
              columns: [
                {
                  label: "Name",
                  key: "name",
                },
              ],
            },
          ],
        },
        "public",
      )
    ).statusCode,
    404,
  );
  const shared = await uploadFile(
    f.ctx,
    f.users.admin,
    {
      orgId: f.orgA,
    },
    "shared.json",
    Buffer.from('[{"name":"Shared"}]'),
  );
  await shareFile(f.ctx, f.users.admin, shared.id, f.projectA, "read");
  const a = await publish(
    f,
    {
      version: 1,
      blocks: [
        {
          type: "table",
          fileId: shared.id,
          columns: [
            {
              label: "Name",
              key: "name",
            },
          ],
        },
      ],
    },
    "public",
  );
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(
    (await f.request(undefined, "GET", a.json().url)).statusCode,
    200,
  );
  await revokeShare(f.ctx, f.users.admin, shared.id, f.projectA);
  assert.equal(
    (await f.request(undefined, "GET", a.json().url)).statusCode,
    403,
  );
  const staticReport = await publish(
    f,
    {
      version: 1,
      blocks: [
        {
          type: "text",
          text: "Creator private",
        },
      ],
    },
    "public",
  );
  await f.request(
    "admin",
    "DELETE",
    `/enterprise/api/organizations/${f.orgA}/members/${f.users.full.id}`,
  );
  assert.equal(
    (await f.request(undefined, "GET", staticReport.json().url)).statusCode,
    404,
  );
});
test("image resources repeat visibility checks and reject SVG active content and symlink source swaps", async (t) => {
  const f = await platformFixture(t),
    scope = {
      orgId: f.orgA,
      projectId: f.projectA,
    };
  const image = await uploadFile(
    f.ctx,
    f.users.full,
    scope,
    "pixel.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const a = await publish(f, {
    version: 1,
    blocks: [
      {
        type: "image",
        fileId: image.id,
        alt: "A pixel",
      },
    ],
  });
  assert.equal(a.statusCode, 201, a.body);
  const url = a.json().url + "/images/0";
  assert.equal((await f.request(undefined, "GET", url)).statusCode, 401);
  assert.equal(
    (await f.request("read", "GET", url)).headers["content-type"],
    "image/png",
  );
  await f.request("full", "PATCH", `/enterprise/api/assets/${a.json().id}`, {
    visibility: "public",
  });
  assert.equal((await f.request(undefined, "GET", url)).statusCode, 200);
  const svg = await uploadFile(
    f.ctx,
    f.users.full,
    scope,
    "active.svg",
    Buffer.from('<svg onload="alert(1)"></svg>'),
  );
  assert.equal(
    (
      await publish(
        f,
        {
          version: 1,
          blocks: [
            {
              type: "image",
              fileId: svg.id,
              alt: "x",
            },
          ],
        },
        "public",
      )
    ).statusCode,
    422,
  );
  const source = join(scopeRoot(f.ctx, scope), "pixel.png"),
    privatePath = join(f.stateDir, "secret.txt");
  await writeFile(privatePath, "Private marker");
  await unlink(source);
  await symlink(privatePath, source);
  const page = await f.request(undefined, "GET", url);
  assert.ok([403, 404, 409].includes(page.statusCode));
  assert.doesNotMatch(page.body, /Private marker/);
});
test("public renders bound source reads, repeated-source amplification, and empty-cell markup", async (t) => {
  const f = await platformFixture(t),
    scope = {
      orgId: f.orgA,
      projectId: f.projectA,
    };
  const file = await uploadFile(
    f.ctx,
    f.users.full,
    scope,
    "bounded.json",
    Buffer.from(
      JSON.stringify(
        Array.from(
          {
            length: 1000,
          },
          () => ({
            value: "",
          }),
        ),
      ),
    ),
  );
  const table = {
    type: "table",
    fileId: file.id,
    columns: Array.from(
      {
        length: 20,
      },
      () => ({
        label: "Value",
        key: "value",
      }),
    ),
  };
  assert.equal(
    (
      await publish(
        f,
        {
          version: 1,
          blocks: Array.from(
            {
              length: 6,
            },
            () => table,
          ),
        },
        "public",
      )
    ).statusCode,
    413,
  );
  const report = await publish(
    f,
    {
      version: 1,
      blocks: [table],
    },
    "public",
  );
  assert.equal(report.statusCode, 201, report.body);
  // A native edit may grow beyond the limit without updating file metadata.
  await writeFile(
    join(scopeRoot(f.ctx, scope), "bounded.json"),
    Buffer.alloc(4 * 1024 * 1024 + 1, 32),
  );
  assert.equal(
    (await f.request(undefined, "GET", report.json().url)).statusCode,
    413,
  );
  // Repeated projected values count their escaped bytes and all emitted markup.
  await writeFile(
    join(scopeRoot(f.ctx, scope), "bounded.json"),
    JSON.stringify(
      Array.from(
        {
          length: 1000,
        },
        () => ({
          value: "&".repeat(1000),
        }),
      ),
    ),
  );
  assert.equal(
    (await f.request(undefined, "GET", report.json().url)).statusCode,
    413,
  );
});
