import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
const fixturePath = "platform/.state/e2e/fixture.json";
const ensureFixture = async (page) => {
  const existing = JSON.parse(await readFile(fixturePath, "utf8"));
  if (existing.orgId) return existing;
  const session = await (await page.request.get("/api/session")).json();
  const headers = {
    origin: existing.origin,
    "x-csrf-token": session.csrfToken,
  };
  const orgResponse = await page.request.post("/api/organizations", {
    headers,
    data: { name: "Example Test Organization" },
  });
  expect(orgResponse.status()).toBe(201);
  const org = await orgResponse.json();
  const projectResponse = await page.request.post(
    `/api/organizations/${org.id}/projects`,
    {
      headers,
      data: {
        name: "Case review",
        description: "Synthetic browser acceptance workspace",
      },
    },
  );
  expect(projectResponse.status()).toBe(202);
  const project = await projectResponse.json();
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await page.request.get(`/api/projects/${project.id}`);
    if ((await status.json()).status === "ready") break;
    await page.waitForTimeout(100);
  }
  async function activateInvite({ email, name, role, password, statePath }) {
    const invite = await page.request.post(
      `/api/organizations/${org.id}/invitations`,
      { headers, data: { email, name, role } },
    );
    expect(invite.status()).toBe(202);
    const invitation = await invite.json();
    const inviteeContext = await page.context().browser().newContext();
    try {
      const activate = await inviteeContext.request.post(
        `${existing.origin}/api/activate`,
        {
          headers: { origin: existing.origin },
          data: {
            token: new URL(invitation.activationUrl).searchParams.get("token"),
            password,
          },
        },
      );
      expect(activate.status()).toBe(200);
      await inviteeContext.storageState({ path: statePath });
    } finally {
      await inviteeContext.close();
    }
    return invitation.user.id;
  }
  const memberId = await activateInvite({
    email: "analyst@example.test",
    name: "Case Analyst",
    role: "member",
    password: "member correct test password 47",
    statePath: "platform/.state/e2e/member-auth.json",
  });
  const adminId = await activateInvite({
    email: "org-admin@example.test",
    name: "Organization Admin",
    role: "admin",
    password: "admin correct test password 47",
    statePath: "platform/.state/e2e/org-admin-auth.json",
  });
  const grant = await page.request.post(`/api/projects/${project.id}/members`, {
    headers,
    data: { userId: memberId, access: "write" },
  });
  expect(grant.status()).toBe(201);
  const result = {
    ...existing,
    orgId: org.id,
    projectId: project.id,
    memberId,
    adminId,
  };
  await writeFile(fixturePath, JSON.stringify(result));
  return result;
};
test("zero-org owner overview and personal settings remain usable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No organizations yet", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/zero-org-owner-green-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Test Owner", exact: false }).click();
  await expect(
    page.getByRole("heading", { name: "Personal settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("owner@example.test")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No organization access", exact: true }),
  ).toBeVisible();
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "fixture_error", message: "Profile unavailable" },
      }),
    }),
  );
  await page.reload();
  await expect(page.getByText("Profile unavailable")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No organization access", exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/me");
  await page.reload();
  await page.getByLabel("Display name").fill("Example Browser Owner");
  await page.getByLabel("Theme").selectOption("cognac");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Profile updated.")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cognac");
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue(
    "Example Browser Owner",
  );
  await expect(page.getByLabel("Theme")).toHaveValue("cognac");
  await page.screenshot({
    path: "test-results/personal-settings-cognac-desktop.png",
    fullPage: true,
  });
  await page.route("**/api/password-reset/request", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "mail_unavailable", message: "Reset delivery failed" },
      }),
    }),
  );
  await page.getByRole("button", { name: "Request password reset" }).click();
  await expect(page.getByText("Reset delivery failed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request password reset" })).toBeEnabled();
  await page.unroute("**/api/password-reset/request");
  await page.getByLabel("Theme").selectOption("green");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "green");
  await page.screenshot({ path: "test-results/personal-settings-green-desktop.png", fullPage: true });
  await expect(page.locator(".sidebar").getByRole("link", { name: "WovenMatter Enterprise Platform", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar").getByRole("link", { name: "Administration", exact: true })).toHaveCount(0);
  await expect(page.locator(".account")).toContainText("Settings · Example Browser Owner");
  await expect(page.locator(".account")).not.toContainText("Platform owner");
  await page.getByRole("button", { name: "New Organization", exact: true }).click();
  await page.getByLabel("Organization name", { exact: true }).fill("Browser-created organization");
  await page.getByRole("dialog").getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator(".org-title")).toContainText("Browser-created organization");
  await page.getByRole("link", { name: "Back to administration", exact: true }).click();
  await expect(page.locator(".sidebar").getByRole("link", { name: "Browser-created organization", exact: true })).toBeVisible();
  await page.locator(".sidebar").getByRole("link", { name: "Browser-created organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar .brand")).toHaveCount(0);
});
test("project creation, ordinary files, organization sharing and revocation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await ensureFixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await page
    .locator(".sidebar").getByRole("link", { name: "Example Test Organization", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Back to administration", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Back to administration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await page
    .locator(".sidebar").getByRole("link", { name: "Example Test Organization", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/projects-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Browser-created workspace");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser-created workspace" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Evidence");
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Evidence", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "case-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Original evidence fixture"),
  });
  await expect(page.getByText("case-notes.txt", { exact: true })).toBeVisible();
  await page.getByLabel("Actions for case-notes.txt").selectOption("rename");
  await page.getByLabel("Name", { exact: true }).fill("renamed-notes.txt");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    page.getByText("renamed-notes.txt", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await expect(page.locator(".file-path")).toHaveCount(0);
  const views = page.getByRole("group", { name: "Library view" });
  await expect(views.getByRole("button", { name: "Files", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Published outputs", exact: true })).toBeHidden();
  await views.getByRole("button", { name: "Published Outputs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Published outputs", exact: true })).toBeVisible();
  await views.getByRole("button", { name: "Files", exact: true }).click();

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Shared references");
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await page
    .getByLabel("Actions for Shared references")
    .selectOption("sharing");
  await page
    .getByLabel("Project", { exact: true })
    .selectOption({ label: "Case review" });
  await page
    .getByRole("button", { name: "Share with project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unshare", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Shared references", exact: true }).click();
  await expect(page.getByRole("button", { name: "Parent folder" })).toBeVisible();
  await views.getByRole("button", { name: "Published Outputs", exact: true }).click();
  await views.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("button", { name: "Parent folder" })).toBeVisible();
  await page.goto(`/organizations/${f.orgId}/projects/${f.projectId}/files`);
  await expect(
    page.getByText("Shared with this project", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await page
    .getByLabel("Actions for Shared references")
    .selectOption("sharing");
  await page.getByRole("button", { name: "Unshare", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unshare", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.goto(`/organizations/${f.orgId}/projects/${f.projectId}/files`);
  await expect(
    page.getByText("Shared with this project", { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("durable conversation streams and can add a project colleague", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(`/organizations/${f.orgId}/projects/${f.projectId}`);
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .first()
    .click();
  await page.getByLabel("Title", { exact: true }).fill("Browser conversation");
  await page
    .getByLabel("Model", { exact: true })
    .selectOption("gpt-test-fixture");
  await page
    .getByRole("button", { name: "Create conversation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser conversation", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Message your agent").fill("Test durable delivery");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText(
      "Synthetic protocol fixture: the request reached the durable runtime.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Test durable delivery", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Conversation members", exact: true })
    .click();
  await page
    .getByLabel("Project member", { exact: true })
    .selectOption(f.memberId);
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  await expect(
    page.getByText("analyst@example.test", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page.getByRole("button", { name: /Browser conversation/ }).click();
  await expect(
    page.getByText("Test durable delivery", { exact: true }),
  ).toBeVisible();
});
test("static library publication has an isolated public origin and revocable link", async ({
  page,
  context,
}) => {
  const f = await ensureFixture(page);
  await page.goto(`/organizations/${f.orgId}/library`);
  await page.getByRole("button", { name: "New asset", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser report");
  await page.getByRole("button", { name: "Create asset", exact: true }).click();
  await page
    .getByRole("button", { name: "Publish first version", exact: true })
    .click();
  await page.getByLabel("Files", { exact: true }).setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      "<!doctype html><title>Published fixture</title><h1>Published browser report</h1>",
    ),
  });
  await page
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await expect(
    page.getByText("A new version has been published."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sharing", exact: true }).click();
  await page.getByLabel("Who can access").selectOption("public");
  await page
    .getByRole("button", { name: "Create share link", exact: true })
    .click();
  const url = await page.getByLabel("Created share link").inputValue();
  const view = await context.newPage();
  await view.goto(url);
  await expect(
    view.getByRole("heading", { name: "Published browser report" }),
  ).toBeVisible();
  expect(new URL(view.url()).hostname).toMatch(/\.localhost$/);
  expect(new URL(view.url()).hostname).not.toEqual("localhost");
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await view.reload();
  await expect(
    view.getByRole("heading", { name: "Published browser report" }),
  ).toHaveCount(0);
  await view.close();
});
test("admin invitation is copyable and mobile navigation remains usable", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(`/organizations/${f.orgId}/settings/members`);
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Invited Analyst");
  await page.getByLabel("Email", { exact: true }).fill("invited@example.test");
  await page
    .getByRole("button", { name: "Send invitation", exact: true })
    .click();
  await expect(
    page.getByText("invited@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("input[readonly]").filter({ visible: true }),
  ).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const closeNav = page.locator(".sidebar").getByRole("button", { name: "Close navigation" });
  await expect(closeNav).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeNav).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  await page.getByRole("button", { name: "Open navigation" }).click();

  await expect(
    page.getByRole("link", { name: "Members", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Organization settings", exact: true })
    .click();
  await page.getByRole("link", { name: /Connections/ }).click();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-connections.png",
    fullPage: true,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "New Organization", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "New organization", exact: true })).toBeVisible();
  expect(await page.getByRole("dialog", { name: "New organization", exact: true }).evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("organization settings hub, nested pages, admin reset action and personal return", async ({
  page,
  browser,
}) => {
  const f = await ensureFixture(page);
  const admin = await browser.newContext({
    storageState: "platform/.state/e2e/org-admin-auth.json",
  });
  try {
    const adminPage = await admin.newPage();
    await adminPage.goto(`/organizations/${f.orgId}/projects`);
    const sidebar = adminPage.locator(".sidebar");
    await expect(sidebar).toContainText("Example Test Organization");
    await expect(
      adminPage.getByRole("link", { name: "Back to administration", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", { name: "Projects", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Library", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Members", exact: true }),
    ).toHaveCount(0);
    await sidebar
      .getByRole("link", { name: "Organization settings", exact: true })
      .click();
    await expect(
      adminPage.getByRole("heading", {
        name: "Organization settings",
        exact: true,
      }),
    ).toBeVisible();
    await adminPage.getByRole("link", { name: /Members/ }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Organization settings", exact: true }),
    ).toHaveClass(/active/);
    await adminPage.route("**/api/organizations/*/members/*/password-reset", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "mail_unavailable", message: "Reset queue unavailable" },
        }),
      }),
    );
    await adminPage
      .locator("tr", { hasText: "analyst@example.test" })
      .getByRole("button", { name: "Send password reset", exact: true })
      .click();
    await expect(adminPage.getByText("Reset queue unavailable")).toBeVisible();
    await adminPage.unroute("**/api/organizations/*/members/*/password-reset");
    await adminPage
      .locator("tr", { hasText: "analyst@example.test" })
      .getByRole("button", { name: "Send password reset", exact: true })
      .click();
    await expect(adminPage.getByText("Password reset email queued.")).toBeVisible();
    await adminPage
      .getByRole("link", { name: "Back to organization settings", exact: true })
      .click();
    await adminPage.getByRole("link", { name: /Connections/ }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Connections", exact: true }),
    ).toBeVisible();
    await adminPage.getByRole("link", { name: "Organization Admin" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Personal settings", exact: true }),
    ).toBeVisible();
    await adminPage
      .getByRole("link", { name: "Back to organization", exact: true })
      .click();
    await expect(
      adminPage.getByRole("heading", { name: "Connections", exact: true }),
    ).toBeVisible();
  } finally {
    await admin.close();
  }
});

test("restricted members do not see owner or administrator navigation", async ({
  page,
  browser,
}) => {
  const f = await ensureFixture(page);
  const member = await browser.newContext({
    storageState: "platform/.state/e2e/member-auth.json",
  });
  try {
    const employee = await member.newPage();
    await employee.goto(`/organizations/${f.orgId}/projects/${f.projectId}`);
    await expect(
      employee.getByRole("heading", { name: "Case review", exact: true }),
    ).toBeVisible();
    await expect(
      employee.getByRole("link", { name: "Back to administration", exact: true }),
    ).toHaveCount(0);
    const sidebar = employee.locator(".sidebar");
    await expect(
      sidebar.getByRole("link", { name: "Members", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", { name: "Connections", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", {
        name: "Organization settings",
        exact: true,
      }),
    ).toHaveCount(0);
    await employee.goto(`/organizations/${f.orgId}/members`);
    await expect(
      employee.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
    await employee.goto(`/organizations/${f.orgId}/settings/members`);
    await expect(
      employee.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
    await employee.goto("/");
    await expect(
      employee.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
  } finally {
    await member.close();
  }
});

test("owner project deep links choose the correct organization", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto("/");
  const session = await (await page.request.get("/api/session")).json();
  const headers = {
    origin: f.origin,
    "x-csrf-token": session.csrfToken,
  };
  const orgResponse = await page.request.post("/api/organizations", {
    headers,
    data: { name: "Second Test Organization" },
  });
  expect(orgResponse.status()).toBe(201);
  const org = await orgResponse.json();
  const projectResponse = await page.request.post(
    `/api/organizations/${org.id}/projects`,
    { headers, data: { name: "Second organization project" } },
  );
  expect(projectResponse.status()).toBe(202);
  const project = await projectResponse.json();
  await page.goto(`/projects/${project.id}/files`);
  await expect(page).toHaveURL(
    new RegExp(`/organizations/${org.id}/projects/${project.id}/files$`),
  );
  await page.goto(`/organizations/${org.id}/projects/${project.id}/files`);
  await expect(
    page.getByRole("link", { name: "Back to administration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Second organization project" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Folder name").fill("Correct organization");
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Correct organization", exact: true }),
  ).toBeVisible();
});

test("read-only collaborators can send a bounded turn in a full-access conversation", async ({
  page,
  browser,
}) => {
  const f = await ensureFixture(page);
  await page.goto(`/organizations/${f.orgId}/projects/${f.projectId}`);
  const session = await (await page.request.get("/api/session")).json();
  const headers = { origin: f.origin, "x-csrf-token": session.csrfToken };
  const threadResponse = await page.request.post(
    `/api/projects/${f.projectId}/conversations`,
    {
      headers,
      data: {
        title: "Read-only collaboration",
        mode: "write",
        model: "gpt-test-fixture",
        harness: "codex",
      },
    },
  );
  expect(threadResponse.status()).toBe(201);
  const thread = await threadResponse.json();
  expect(
    (
      await page.request.post(`/api/conversations/${thread.id}/members`, {
        headers,
        data: { userId: f.memberId },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.patch(
        `/api/projects/${f.projectId}/members/${f.memberId}`,
        { headers, data: { access: "read" } },
      )
    ).ok(),
  ).toBe(true);
  const member = await browser.newContext({
    baseURL: f.origin,
    storageState: "platform/.state/e2e/member-auth.json",
  });
  const employee = await member.newPage();
  try {
    await employee.goto(`/organizations/${f.orgId}/projects/${f.projectId}`);
    await employee
      .getByRole("button", { name: /Read-only collaboration/ })
      .click();
    await employee
      .getByLabel("Message your agent")
      .fill("Question from a read-only collaborator");
    await employee
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      employee.getByText(
        "Synthetic protocol fixture: the request reached the durable runtime.",
        { exact: true },
      ),
    ).toBeVisible();
    const runs = await (
      await member.request.get(`/api/conversations/${thread.id}/runs`)
    ).json();
    expect(runs.items[0].mode).toBe("read");
    await expect(
      employee.getByRole("link", { name: "Connections", exact: true }),
    ).toHaveCount(0);
  } finally {
    await member.close();
  }
});

test("source viewer preserves document versions and renders HTML as text", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(`/organizations/${f.orgId}/projects/${f.projectId}/files`);
  const session = await (await page.request.get("/api/session")).json();
  const headers = { origin: f.origin, "x-csrf-token": session.csrfToken };
  async function upload(name, text, mimeType = "text/plain") {
    const response = await page.request.post("/api/files/upload", {
      headers,
      multipart: {
        orgId: f.orgId,
        projectId: f.projectId,
        file: { name, mimeType, buffer: Buffer.from(text) },
      },
    });
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.errors).toEqual([]);
    return result.items[0];
  }
  const file = await upload(
    "versioned-evidence.txt",
    "Original version evidence.",
  );
  const content = await page.request.get(
    `/api/files/${file.id}/content?projectId=${f.projectId}`,
  );
  const versionId = content.headers()["x-file-version"];
  expect(versionId).toBeTruthy();
  await page.reload();
  await page
    .getByRole("link", { name: "versioned-evidence.txt", exact: true })
    .click();
  await expect(page.locator("pre.text-preview")).toHaveText(
    "Original version evidence.",
  );
  await upload("versioned-evidence.txt", "Updated version evidence.");
  await page.reload();
  await expect(page.locator("pre.text-preview")).toHaveText(
    "Updated version evidence.",
  );
  await page.goto(
    `/organizations/${f.orgId}/source/${file.id}?projectId=${f.projectId}&versionId=${versionId}`,
  );
  await expect(
    page.getByText("Saved document version", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("pre.text-preview")).toHaveText(
    "Original version evidence.",
  );
  const html =
    "<html><script>window.__unsafeSourceExecuted = true</script><h1>Uploaded HTML source</h1></html>";
  const unsafeFile = await upload("source-code.html", html, "text/html");
  await page.goto(
    `/organizations/${f.orgId}/source/${unsafeFile.id}?projectId=${f.projectId}`,
  );
  await expect(page.locator("pre.text-preview")).toHaveText(html);
  expect(
    await page.evaluate(() => window.__unsafeSourceExecuted),
  ).toBeUndefined();
  await expect(
    page.getByRole("heading", { name: "Uploaded HTML source" }),
  ).toHaveCount(0);
});

test("PDF source preview uses a bounded blob and preserves the citation page", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(`/organizations/${f.orgId}/projects/${f.projectId}/files`);
  const session = await (await page.request.get("/api/session")).json();
  const headers = { origin: f.origin, "x-csrf-token": session.csrfToken };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream =
    "BT /F1 18 Tf 60 700 Td (Synthetic source preview fixture) Tj ET\n";
  objects.push(
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  );
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const response = await page.request.post("/api/files/upload", {
    headers,
    multipart: {
      orgId: f.orgId,
      projectId: f.projectId,
      file: {
        name: "citation-fixture.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(pdf),
      },
    },
  });
  expect(response.ok()).toBe(true);
  const file = (await response.json()).items[0];
  const content = await page.request.get(
    `/api/files/${file.id}/content?projectId=${f.projectId}`,
  );
  const version = content.headers()["x-file-version"];
  const violations = [];
  await page.addInitScript(() =>
    document.addEventListener(
      "securitypolicyviolation",
      (event) => (window.__cspViolation = event.violatedDirective),
    ),
  );
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Content Security Policy")
    )
      violations.push(message.text());
  });
  await page.goto(
    `/organizations/${f.orgId}/source/${file.id}?projectId=${f.projectId}&versionId=${version}&page=1`,
  );
  const frame = page.locator("iframe.pdf-preview");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute(
    "src",
    new RegExp(`^blob:${f.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.+#page=1$`),
  );
  await expect(
    page.getByText("Saved document version · Page 1", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__cspViolation)).toBeUndefined();
  expect(violations).toEqual([]);
  await page.screenshot({
    path: "test-results/source-preview-desktop.png",
    fullPage: true,
  });
});
