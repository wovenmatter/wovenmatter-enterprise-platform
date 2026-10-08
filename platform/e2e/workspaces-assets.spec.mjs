// Extends workspace.spec.mjs after its fresh-owner (zero-organization) coverage.
import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
const evidence = process.env.WME_E2E_OUTPUT ?? "/tmp/wme-e2e-evidence";
async function organization(page, name, project = false) {
  const { origin } = JSON.parse(
    await readFile(evidence + "/fixture.json", "utf8"),
  );
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const headers = { origin, "x-csrf-token": session.csrfToken };
  const org = await (
    await page.request.post("/enterprise/api/organizations", {
      headers,
      data: { name },
    })
  ).json();
  let workspace;
  if (project) {
    workspace = await (
      await page.request.post(
        `/enterprise/api/organizations/${org.id}/projects`,
        { headers, data: { name: "Shared asset workspace" } },
      )
    ).json();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/enterprise/api/projects/${workspace.id}`)
            ).json()
          ).status,
        { timeout: 30000 },
      )
      .toBe("ready");
  }
  return { origin, headers, org, project: workspace };
}
async function create(page, f, name, harness, project = false) {
  await page.goto(`/enterprise/organizations/${f.org.id}/library`);
  await expect(
    page.getByRole("heading", { name: "Library", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New asset", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  if (project) await page.getByLabel("Belongs to").selectOption(f.project.id);
  await page.getByRole("button", { name: "Create asset", exact: true }).click();
  await page
    .getByLabel("Model", { exact: true })
    .selectOption("synthetic-asset-" + harness);
  await page.getByLabel("Agent", { exact: true }).selectOption(harness);
}
function errors(page) {
  const values = [];
  page.on("pageerror", (e) => values.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") values.push(m.text());
  });
  return values;
}

test("asset conversation reconnects after acceptance, reads a selected source, and resumes durable draft after idle", async ({
  page,
}) => {
  test.setTimeout(180000);
  const failures = errors(page),
    f = await organization(page, "Standalone conversation fixture");
  const folder = await page.request.post("/enterprise/api/files/folders", {
    headers: f.headers,
    data: { orgId: f.org.id, path: "Read-only inputs" },
  });
  expect(folder.status()).toBe(200);
  const upload = await page.request.post("/enterprise/api/files/upload", {
    headers: f.headers,
    multipart: {
      orgId: f.org.id,
      path: "Read-only inputs",
      file: {
        name: "input.json",
        mimeType: "application/json",
        buffer: Buffer.from('[{"label":"Authorized input","value":8}]'),
      },
    },
  });
  expect(upload.status()).toBe(200);
  await create(page, f, "Resumable asset", "codex");
  await page.getByText("Library sources (0)", { exact: true }).click();
  await page
    .getByRole("button", { name: "Open folder Read-only inputs" })
    .click();
  await page.getByLabel("input.json", { exact: true }).check();
  await page
    .getByRole("button", { name: "Use selected sources", exact: true })
    .click();
  await expect(
    page.getByText("Library sources (1)", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Prepare an asset from the selected source.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByPlaceholder("Message your agent…")).toBeVisible();
  const list = await (
      await page.request.get(`/enterprise/api/organizations/${f.org.id}/assets`)
    ).json(),
    asset = list.items.find((a) => a.name === "Resumable asset");
  const first = await (
    await page.request.get(`/enterprise/api/assets/${asset.id}/agent`)
  ).json();
  expect(first.conversation).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "Assets", exact: true }).click();
  await page
    .getByRole("button", { name: "Resumable asset", exact: true })
    .click();
  await expect(
    page
      .frameLocator('iframe[title="Draft preview"]')
      .getByText("First version for review", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByText("Asset draft saved.", { exact: true }),
  ).toBeVisible();
  const preview = page.frameLocator('iframe[title="Draft preview"]');
  await preview.getByText("Selected source", { exact: true }).click();
  await expect(
    preview.getByText("Authorized input: 8", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/enterprise/api/assets/${asset.id}/agent`)
          ).json()
        ).state,
      { timeout: 20000 },
    )
    .toBe("idle");
  const retained = await (
    await page.request.get(`/enterprise/api/assets/${asset.id}/agent`)
  ).json();
  expect(retained.conversation.id).toBe(first.conversation.id);
  const before = await (
    await page.request.get(
      `/enterprise/api/conversations/${first.conversation.id}/runs`,
    )
  ).json();
  expect(before.items).toHaveLength(1);
  expect(before.items[0].status).toBe("completed");
  await page.screenshot({
    path: evidence + "/asset-idle-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByPlaceholder("Message your agent…")
    .fill("Continue and revise the saved draft.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Draft preview"]')
      .getByText("Second draft kept private", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page
      .frameLocator('iframe[title="Draft preview"]')
      .locator("td")
      .filter({ hasText: /^2$/ }),
  ).toBeVisible();
  const after = await (
    await page.request.get(
      `/enterprise/api/conversations/${first.conversation.id}/runs`,
    )
  ).json();
  expect(after.items).toHaveLength(2);
  const original = await page.request.get(
    `/enterprise/api/files/${(await upload.json()).items[0].id}/content`,
  );
  expect(await original.text()).toBe(
    '[{"label":"Authorized input","value":8}]',
  );
  await page
    .getByRole("button", { name: "Send message", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: evidence + "/asset-resumed-mobile.png",
    fullPage: true,
  });
  await page.locator('iframe[title="Draft preview"]').scrollIntoViewIfNeeded();
  await expect(page.locator('iframe[title="Draft preview"]')).toBeInViewport();
  await page.screenshot({
    path: evidence + "/asset-preview-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await writeFile(
    evidence + "/asset-reconnect-console.json",
    JSON.stringify(failures, null, 2),
  );
  expect(failures).toEqual([]);
});

test("Claude Grok and Pi asset conversations share one project and keep independent drafts", async ({
  page,
}) => {
  test.setTimeout(180000);
  const failures = errors(page),
    f = await organization(page, "Concurrent adapter fixture", true);
  const pages = [
    page,
    await page.context().newPage(),
    await page.context().newPage(),
  ];
  for (const other of pages.slice(1))
    other.on("pageerror", (e) => failures.push(e.message));
  await Promise.all(
    ["claude", "grok", "pi"].map(async (h, i) => {
      const p = pages[i];
      await create(p, f, "Asset " + h, h, true);
      await p
        .getByLabel("Message", { exact: true })
        .fill("Prepare this independent asset in our shared workspace.");
      await p
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect(
        p
          .frameLocator('iframe[title="Draft preview"]')
          .getByText("First version for review", { exact: true }),
      ).toBeVisible({ timeout: 90000 });
      await expect(
        p.getByText("Asset draft saved.", { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await p.screenshot({
        path: evidence + "/asset-" + h + "-desktop.png",
        fullPage: true,
      });
    }),
  );
  const assets = await (
    await page.request.get(`/enterprise/api/organizations/${f.org.id}/assets`)
  ).json();
  expect(assets.items).toHaveLength(3);
  const details = await Promise.all(
    assets.items.map(async (a) =>
      (await page.request.get(`/enterprise/api/assets/${a.id}/agent`)).json(),
    ),
  );
  expect(new Set(details.map((d) => d.conversation.id)).size).toBe(3);
  expect(details.every((d) => d.conversation.projectId === f.project.id)).toBe(
    true,
  );
  if (process.env.WME_E2E_AGENT_IMAGE) {
    const ledger = JSON.parse(
      await readFile(evidence + "/native-allocation.json", "utf8"),
    );
    expect(
      ledger.resources
        .filter((r) => r.organizationId === f.org.id)
        .map((r) => r.projectId),
    ).toEqual([f.project.id]);
  }
  // An asset is not an invitation into any ordinary private project thread.
  expect(
    (
      await (
        await page.request.get(
          `/enterprise/api/projects/${f.project.id}/conversations`,
        )
      ).json()
    ).items,
  ).toEqual([]);
  for (const other of pages.slice(1)) await other.close();
  await writeFile(
    evidence + "/asset-adapters-console.json",
    JSON.stringify(failures, null, 2),
  );
  expect(failures).toEqual([]);
});
