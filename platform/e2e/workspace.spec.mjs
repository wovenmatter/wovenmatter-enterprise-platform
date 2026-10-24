import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
// Composer selectors are titled popouts (WovenMatter composer pickers):
// open the real trigger, then choose the visible option.
async function choose(page, label, value) {
  await page.getByRole("button", { name: new RegExp(`^${label}\\b`) }).click();
  await page.locator(`[role="option"][data-value="${value}"]`).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
const picker = (page, label) =>
  page.getByRole("button", { name: new RegExp(`^${label}\\b`) });
const evidence = process.env.WME_E2E_OUTPUT ?? "/tmp/wme-e2e-evidence";
const fixturePath = `${evidence}/fixture.json`;
const ensureFixture = async (page) => {
  const existing = JSON.parse(await readFile(fixturePath, "utf8"));
  if (existing.orgId) return existing;
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const headers = {
    origin: existing.origin,
    "x-csrf-token": session.csrfToken,
  };
  const orgResponse = await page.request.post("/enterprise/api/organizations", {
    headers,
    data: {
      name: "Example Test Organization",
    },
  });
  expect(orgResponse.status()).toBe(201);
  const org = await orgResponse.json();
  const projectResponse = await page.request.post(
    `/enterprise/api/organizations/${org.id}/projects`,
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
    const status = await page.request.get(
      `/enterprise/api/projects/${project.id}`,
    );
    if ((await status.json()).status === "ready") break;
    await page.waitForTimeout(100);
  }
  async function activateInvite({ email, name, role, password, statePath }) {
    const invite = await page.request.post(
      `/enterprise/api/organizations/${org.id}/invitations`,
      {
        headers,
        data: {
          email,
          name,
          role,
        },
      },
    );
    expect(invite.status()).toBe(202);
    const invitation = await invite.json();
    const inviteeContext = await page.context().browser().newContext();
    try {
      const activate = await inviteeContext.request.post(
        `${existing.origin}/enterprise/api/activate`,
        {
          headers: {
            origin: existing.origin,
          },
          data: {
            token: new URL(invitation.activationUrl).searchParams.get("token"),
            password,
          },
        },
      );
      expect(activate.status()).toBe(200);
      await inviteeContext.storageState({
        path: statePath,
      });
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
    statePath: `${evidence}/member-auth.json`,
  });
  const adminId = await activateInvite({
    email: "org-admin@example.test",
    name: "Organization Admin",
    role: "admin",
    password: "admin correct test password 47",
    statePath: `${evidence}/org-admin-auth.json`,
  });
  const grant = await page.request.post(
    `/enterprise/api/projects/${project.id}/members`,
    {
      headers,
      data: {
        userId: memberId,
        access: "write",
      },
    },
  );
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
  await page.goto("/enterprise");
  await expect(
    page.getByRole("heading", {
      name: "Organizations",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No organizations yet",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}/zero-org-owner-green-desktop.png`,
    fullPage: true,
  });
  await page
    .getByRole("link", {
      name: "Personal settings",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Personal settings",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("owner@example.test")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No organization access",
      exact: true,
    }),
  ).toBeVisible();
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "fixture_error",
          message: "Profile unavailable",
        },
      }),
    }),
  );
  await page.reload();
  await expect(page.getByText("Profile unavailable")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No organization access",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.unroute("**/api/me");
  await page.reload();
  await page.getByLabel("Display name").fill("Example Browser Owner");
  await page.getByRole("radio", { name: "Cognac theme" }).check();
  await page
    .getByRole("button", {
      name: "Save profile",
      exact: true,
    })
    .click();
  await expect(page.getByText("Profile updated.")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cognac");
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue(
    "Example Browser Owner",
  );
  await expect(page.getByRole("radio", { name: "Cognac theme" })).toBeChecked();
  await page.screenshot({
    path: `${evidence}/personal-settings-cognac-desktop.png`,
    fullPage: true,
  });
  await page.route("**/api/password-reset/request", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "mail_unavailable",
          message: "Reset delivery failed",
        },
      }),
    }),
  );
  await page
    .getByRole("button", {
      name: "Request password reset",
    })
    .click();
  await expect(page.getByText("Reset delivery failed")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Request password reset",
    }),
  ).toBeEnabled();
  await page.unroute("**/api/password-reset/request");
  await page.getByRole("radio", { name: "Green theme" }).check();
  await page
    .getByRole("button", {
      name: "Save profile",
      exact: true,
    })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "green");
  await page.screenshot({
    path: `${evidence}/personal-settings-green-desktop.png`,
    fullPage: true,
  });
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".platform-header")).toBeVisible();
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Create organization",
      exact: true,
    })
    .first()
    .click();
  await page
    .getByLabel("Organization name", {
      exact: true,
    })
    .fill("Browser-created organization");
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: "Create organization",
      exact: true,
    })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Workspaces",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".org-title")).toContainText(
    "Browser-created organization",
  );
  await page
    .getByRole("link", {
      name: "Admin",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("link", {
      name: "Browser-created organization",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Browser-created organization",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Workspaces",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".sidebar .brand")).toHaveCount(0);
});
test("project creation, ordinary files, organization sharing and revocation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await ensureFixture(page);
  await page.goto("/enterprise");
  await expect(
    page.getByRole("heading", {
      name: "Organizations",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Example Test Organization",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("link", {
      name: "Admin",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Admin",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Organizations",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Example Test Organization",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Workspaces",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}/projects-desktop.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: "New workspace",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Workspace name", {
      exact: true,
    })
    .fill("Browser-created workspace");
  await page
    .getByRole("button", {
      name: "Create workspace",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Browser-created workspace",
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Workspace Files",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "New folder",
    })
    .click();
  await page.getByLabel("Folder name").fill("Evidence");
  await page
    .getByRole("button", {
      name: "Create folder",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Evidence",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Evidence",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Upload files", {
      exact: true,
    })
    .setInputFiles({
      name: "case-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Original evidence fixture"),
    });
  await expect(
    page.getByText("case-notes.txt", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Actions for case-notes.txt" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page
    .getByLabel("Name", {
      exact: true,
    })
    .fill("renamed-notes.txt");
  await page
    .getByRole("button", {
      name: "Rename",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("renamed-notes.txt", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(`/enterprise/organizations/${f.orgId}/files`);
  await expect(
    page.getByRole("heading", {
      name: "Organization Files",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Files",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".file-path")).toHaveCount(0);
  const views = page.getByRole("group", {
    name: "Library view",
  });
  await expect(
    views.getByRole("button", {
      name: "Files",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", {
      name: "Assets",
      exact: true,
    }),
  ).toBeHidden();
  await views
    .getByRole("button", {
      name: "Assets",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Files",
      exact: true,
    }),
  ).toBeHidden();
  await expect(
    page.getByRole("heading", {
      name: "Assets",
      exact: true,
    }),
  ).toBeVisible();
  await views
    .getByRole("button", {
      name: "Files",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "New folder",
    })
    .click();
  await page.getByLabel("Folder name").fill("Shared references");
  await page
    .getByRole("button", {
      name: "Create folder",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Actions for Shared references" })
    .click();
  await page
    .getByRole("menuitem", { name: "Share with workspaces", exact: true })
    .click();
  await page
    .getByLabel("Workspace", {
      exact: true,
    })
    .selectOption({
      label: "Case review",
    });
  await page
    .getByRole("button", {
      name: "Share with workspace",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Unshare",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Close dialog",
    })
    .click();
  await page
    .getByRole("button", {
      name: "Shared references",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Parent folder",
    }),
  ).toBeVisible();
  await views
    .getByRole("button", {
      name: "Assets",
      exact: true,
    })
    .click();
  await views
    .getByRole("button", {
      name: "Files",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Parent folder",
    }),
  ).toBeVisible();
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}/files`,
  );
  await expect(
    page.getByText("Organization Files source", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(`/enterprise/organizations/${f.orgId}/files`);
  await page
    .getByRole("button", { name: "Actions for Shared references" })
    .click();
  await page
    .getByRole("menuitem", { name: "Share with workspaces", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Unshare",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Unshare",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Close dialog",
    })
    .click();
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}/files`,
  );
  await expect(
    page.getByText("Organization Files source", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("durable conversation streams are shared automatically with workspace colleagues", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}`,
  );
  await page
    .getByRole("link", {
      name: "New chat",
      exact: true,
    })
    .first()
    .click();
  await expect(page.getByRole("dialog").getByLabel("Agent", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Session permissions")).toHaveCount(0);
  await expect(
    page.getByRole("dialog").getByLabel("Title", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Start session",
      exact: true,
    })
    .click();
  await expect(picker(page, "Conversation model")).toHaveAttribute(
    "data-value",
    "gpt-test-fixture",
  );
  await choose(page, "Thinking level", "high");
  await expect(picker(page, "Thinking level")).toHaveAttribute(
    "data-value",
    "high",
  );
  await expect(
    page.getByRole("heading", {
      name: "New chat",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Conversation settings", exact: true })
    .click();
  await page.getByLabel("Title", { exact: true }).fill("Browser conversation");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await choose(page, "Message mode", "comment");
  await page.getByLabel("Message your agent").fill("Background comment only");
  await page
    .getByRole("button", {
      name: "Send comment",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Background comment only", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Synthetic protocol fixture: the request reached the durable runtime.",
      {
        exact: true,
      },
    ),
  ).toHaveCount(0);
  await choose(page, "Message mode", "message");
  await choose(page, "Conversation model", "gpt-test-fixture");
  await page.getByLabel("Message your agent").fill("Test durable delivery");
  await page
    .getByRole("button", {
      name: "Send message",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Synthetic protocol fixture: the request reached the durable runtime.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Test durable delivery", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}/workspace-desktop.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  const stopBackground = page.getByRole("menuitem", { name: "Stop background work",
    exact: true,
  });
  await expect(stopBackground).toBeVisible();
  await expect(stopBackground).toHaveAttribute(
    "title",
    /Other threads keep running/,
  );
  const stopResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/cancel") &&
      response.request().method() === "POST",
  );
  await stopBackground.click();
  expect((await stopResponse).ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Browser conversation", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Conversation members", exact: true })).toHaveCount(0);
  const memberContext = await page.context().browser().newContext({ baseURL: f.origin, storageState: `${evidence}/member-auth.json` });
  try {
    const listed = await (await memberContext.request.get(`/enterprise/api/projects/${f.projectId}/conversations`)).json();
    expect(listed.items.some(item => item.title === "Browser conversation")).toBe(true);
  } finally { await memberContext.close(); }
  await page.reload();
  await page
    .getByRole("complementary", { name: "Workspace content", exact: true })
    .getByRole("link", {
      name: /Browser conversation/,
    })
    .click();
  await expect(
    page.getByText("Test durable delivery", {
      exact: true,
    }),
  ).toBeVisible();
});
test("safe report publication is public without JavaScript and visibility changes revoke anonymous access", async ({
  page,
  browser,
}) => {
  const f = await ensureFixture(page),
    session = await (await page.request.get("/enterprise/api/session")).json(),
    headers = {
      origin: f.origin,
      "x-csrf-token": session.csrfToken,
    };
  const png = await page.request.post("/enterprise/api/files/upload", {
    headers,
    multipart: {
      orgId: f.orgId,
      projectId: f.projectId,
      files: {
        name: "report-pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      },
    },
  });
  expect(png.status()).toBe(200);
  const image = (await png.json()).items[0];
  const upload = await page.request.post("/enterprise/api/files/upload", {
    headers,
    multipart: {
      orgId: f.orgId,
      projectId: f.projectId,
      files: {
        name: "browser.report.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            version: 1,
            blocks: [
              {
                type: "heading",
                text: "Published browser report",
              },
              {
                type: "text",
                text: "Current authorized information",
              },
              {
                type: "image",
                fileId: image.id,
                alt: "Report pixel",
              },
            ],
          }),
        ),
      },
    },
  });
  expect(upload.status()).toBe(200);
  const file = (await upload.json()).items[0];
  await page.goto(`/enterprise/organizations/${f.orgId}/library`);
  await page
    .getByRole("button", {
      name: "Assets",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "New asset", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser report");
  await page.getByLabel("Belongs to").selectOption(f.projectId);
  const creation = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/enterprise/api/organizations/${f.orgId}/assets`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create asset", exact: true }).click();
  expect((await creation).status()).toBe(201);
  // Keep the renderer/import-compatibility regression through its existing API;
  // conversational preparation is covered by the asset agent workflow below.
  const assetList = await (
    await page.request.get(`/enterprise/api/organizations/${f.orgId}/assets`)
  ).json();
  const selectedAsset = assetList.items.find(
    (a) => a.name === "Browser report",
  );
  const asset = await (
    await page.request.get(`/enterprise/api/assets/${selectedAsset.id}`)
  ).json();
  const prepared = await page.request.patch(
    `/enterprise/api/assets/${asset.id}`,
    {
      headers,
      data: { expectedRevision: asset.revision, sourceFileId: file.id },
    },
  );
  expect(prepared.status()).toBe(200);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Browser report", exact: true })
    .click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByLabel("Visibility", { exact: true }).selectOption("public");
  await page
    .getByRole("button", { name: "Publish asset", exact: true })
    .click();
  const link = page.getByRole("link", { name: "Open published asset" });
  await expect(link).toBeVisible();
  const url = await link.getAttribute("href");
  expect(url).toMatch(/^\/enterprise\/reports\//);
  const anonymous = await browser.newContext({
    baseURL: f.origin,
    javaScriptEnabled: false,
    storageState: {
      cookies: [],
      origins: [],
    },
  });
  const view = await anonymous.newPage();
  try {
    const response = await view.goto(url);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toContain(
      "script-src 'none'",
    );
    await expect(
      view.getByRole("heading", {
        name: "Published browser report",
      }),
    ).toBeVisible();
    await expect(view.locator("script,iframe,form")).toHaveCount(0);
    await expect(
      view.getByRole("img", {
        name: "Report pixel",
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        view
          .getByRole("img", {
            name: "Report pixel",
          })
          .evaluate((img) => img.naturalWidth),
      )
      .toBe(1);
    await view.screenshot({
      path: `${evidence}/safe-report-desktop.png`,
      fullPage: true,
    });
    await view.setViewportSize({
      width: 390,
      height: 844,
    });
    await view.screenshot({
      path: `${evidence}/safe-report-mobile.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByLabel("Visibility", { exact: true })
      .selectOption("project");
    await page
      .getByRole("button", { name: "Change visibility", exact: true })
      .click();
    await expect(page.getByLabel("Visibility", { exact: true })).toHaveValue(
      "project",
    );
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    const authorizedView = await page.context().newPage();
    try {
      expect((await authorizedView.goto(url)).status()).toBe(200);
      await expect
        .poll(() =>
          authorizedView
            .getByRole("img", {
              name: "Report pixel",
            })
            .evaluate((img) => img.naturalWidth),
        )
        .toBe(1);
    } finally {
      await authorizedView.close();
    }
    expect((await view.reload()).status()).toBe(401);
    await expect(
      view.getByRole("heading", {
        name: "Published browser report",
      }),
    ).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
});
test("admin invitation is copyable and mobile navigation remains usable", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(`/enterprise/organizations/${f.orgId}/settings/members`);
  await page
    .getByRole("button", {
      name: "Invite member",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Name", {
      exact: true,
    })
    .fill("Invited Analyst");
  await page
    .getByLabel("Email", {
      exact: true,
    })
    .fill("invited@example.test");
  await page
    .getByRole("button", {
      name: "Send invitation",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("invited@example.test", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator("input[readonly]").filter({
      visible: true,
    }),
  ).toHaveCount(1);
  await page.setViewportSize({
    width: 390,
    height: 844,
  });
  await page
    .getByRole("button", {
      name: "Open navigation",
    })
    .click();
  const closeNav = page.getByRole("dialog", { name: "Navigation", exact: true }).getByRole("button", {
    name: "Close navigation",
  });
  await expect(closeNav).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.locator(".sidebar").getByRole("link", {
      name: "Settings",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeNav).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", {
      name: "Open navigation",
    }),
  ).toBeFocused();
  await page
    .getByRole("button", {
      name: "Open navigation",
    })
    .click();
  await expect(
    page.getByRole("link", {
      name: "Members",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Settings",
      exact: true,
    })
    .click();
  await page
    .locator("main")
    .getByRole("link", {
      name: /Connections/,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Connections",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${evidence}/mobile-connections.png`,
    fullPage: true,
  });
  await page.goto("/enterprise");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Create organization",
      exact: true,
    })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Navigation",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", {
      name: "New organization",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page
      .getByRole("dialog", {
        name: "New organization",
        exact: true,
      })
      .evaluate((dialog) => dialog.contains(document.activeElement)),
  ).toBe(true);
  await page
    .getByRole("button", {
      name: "Cancel",
      exact: true,
    })
    .click();
});
test("organization settings hub, nested pages, admin reset action and personal return", async ({
  page,
  browser,
}) => {
  const f = await ensureFixture(page);
  const admin = await browser.newContext({
    storageState: `${evidence}/org-admin-auth.json`,
  });
  try {
    const adminPage = await admin.newPage();
    await adminPage.goto(`/enterprise/organizations/${f.orgId}/workspaces`);
    const sidebar = adminPage.locator(".sidebar");
    await expect(sidebar).toContainText("Example Test Organization");
    await expect(
      adminPage.getByRole("link", {
        name: "Admin",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", {
        name: "Workspaces",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", {
        name: "Organization Files",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", {
        name: "Members",
        exact: true,
      }),
    ).toBeVisible();
    await sidebar
      .getByRole("link", {
        name: "Settings",
        exact: true,
      })
      .click();
    await expect(
      adminPage.getByRole("heading", {
        name: "Organization settings",
        exact: true,
      }),
    ).toBeVisible();
    await adminPage
      .locator("main")
      .getByRole("link", {
        name: /Members/,
      })
      .click();
    await expect(
      adminPage.getByRole("heading", {
        name: "Members",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", {
        name: "Members",
        exact: true,
      }),
    ).toHaveClass(/active/);
    await adminPage.route(
      "**/api/organizations/*/members/*/password-reset",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "mail_unavailable",
              message: "Reset queue unavailable",
            },
          }),
        }),
    );
    await adminPage
      .locator("tr", {
        hasText: "analyst@example.test",
      })
      .getByRole("button", {
        name: "Send password reset",
        exact: true,
      })
      .click();
    await expect(adminPage.getByText("Reset queue unavailable")).toBeVisible();
    await adminPage.unroute("**/api/organizations/*/members/*/password-reset");
    await adminPage
      .locator("tr", {
        hasText: "analyst@example.test",
      })
      .getByRole("button", {
        name: "Send password reset",
        exact: true,
      })
      .click();
    await expect(
      adminPage.getByText("Password reset email queued."),
    ).toBeVisible();
    await adminPage
      .getByRole("link", {
        name: "Settings",
        exact: true,
      })
      .click();
    await adminPage
      .locator("main")
      .getByRole("link", {
        name: /Connections/,
      })
      .click();
    await expect(
      adminPage.getByRole("heading", {
        name: "Connections",
        exact: true,
      }),
    ).toBeVisible();
    await adminPage
      .getByRole("link", {
        name: "Personal settings",
      })
      .click();
    await expect(
      adminPage.getByRole("heading", {
        name: "Personal settings",
        exact: true,
      }),
    ).toBeVisible();
    await adminPage
      .getByRole("link", {
        name: "Back to organization",
        exact: true,
      })
      .click();
    await expect(
      adminPage.getByRole("heading", {
        name: "Connections",
        exact: true,
      }),
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
    storageState: `${evidence}/member-auth.json`,
  });
  try {
    const employee = await member.newPage();
    await employee.goto(
      `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}`,
    );
    await expect(
      employee.getByRole("heading", {
        name: "Case review",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      employee.getByRole("link", {
        name: "Admin",
        exact: true,
      }),
    ).toHaveCount(0);
    const sidebar = employee.locator(".sidebar");
    await expect(
      sidebar.getByRole("link", {
        name: "Members",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", {
        name: "Connections",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", {
        name: "Settings",
        exact: true,
      }),
    ).toBeVisible();
    await employee.goto(`/enterprise/organizations/${f.orgId}/members`);
    await expect(
      employee.getByRole("heading", {
        name: "Workspaces",
        exact: true,
      }),
    ).toBeVisible();
    await employee.goto(
      `/enterprise/organizations/${f.orgId}/settings/members`,
    );
    await expect(
      employee.getByRole("heading", {
        name: "Workspaces",
        exact: true,
      }),
    ).toBeVisible();
    await employee.goto("/enterprise");
    await expect(
      employee.getByRole("heading", {
        name: "Workspaces",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await member.close();
  }
});
test("owner project deep links choose the correct organization", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto("/enterprise");
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const headers = {
    origin: f.origin,
    "x-csrf-token": session.csrfToken,
  };
  const orgResponse = await page.request.post("/enterprise/api/organizations", {
    headers,
    data: {
      name: "Second Test Organization",
    },
  });
  expect(orgResponse.status()).toBe(201);
  const org = await orgResponse.json();
  const projectResponse = await page.request.post(
    `/enterprise/api/organizations/${org.id}/projects`,
    {
      headers,
      data: {
        name: "Second organization project",
      },
    },
  );
  expect(projectResponse.status()).toBe(202);
  const project = await projectResponse.json();
  await page.goto(`/enterprise/projects/${project.id}/files`);
  await expect(page).toHaveURL(
    new RegExp(
      `/enterprise/organizations/${org.id}/workspaces/${project.id}/files$`,
    ),
  );
  await page.goto(
    `/enterprise/organizations/${org.id}/workspaces/${project.id}/files`,
  );
  await expect(
    page.getByRole("link", {
      name: "Your organization",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".sidebar").getByText("Second organization project", {exact:true}).first(),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "New folder",
      exact: true,
    })
    .click();
  await page.getByLabel("Folder name").fill("Correct organization");
  await page
    .getByRole("button", {
      name: "Create folder",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Correct organization",
      exact: true,
    }),
  ).toBeVisible();
});
test("legacy read memberships normalize to full shared access while actual removal revokes it", async ({page,browser}) => {
  const f = await ensureFixture(page);
  const session = await (await page.request.get("/enterprise/api/session")).json();
  const headers = {origin:f.origin,"x-csrf-token":session.csrfToken};
  const response = await page.request.post(`/enterprise/api/projects/${f.projectId}/conversations`, {headers,data:{title:"Shared collaboration",mode:"read",model:"gpt-test-fixture"}});
  expect(response.status()).toBe(201);
  const thread = await response.json(); expect(thread.mode).toBe("write");
  expect((await page.request.patch(`/enterprise/api/projects/${f.projectId}/members/${f.memberId}`,{headers,data:{access:"read"}})).ok()).toBe(true);
  const member = await browser.newContext({baseURL:f.origin,storageState:`${evidence}/member-auth.json`});
  try {
    const employee = await member.newPage();
    await employee.goto(`/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}?conversation=${thread.id}`);
    await expect(employee.getByLabel("Message your agent")).toBeEnabled();
    await expect(employee.getByLabel("Session permissions")).toHaveCount(0);
    await employee.getByLabel("Message your agent").fill("Shared member work");
    await employee.getByRole("button",{name:"Send message",exact:true}).click();
    await expect(employee.getByText("Synthetic protocol fixture: the request reached the durable runtime.",{exact:true})).toBeVisible();
    expect((await page.request.delete(`/enterprise/api/projects/${f.projectId}/members/${f.memberId}`,{headers})).ok()).toBe(true);
    expect((await member.request.get(`/enterprise/api/conversations/${thread.id}`)).status()).toBe(404);
    expect((await member.request.get(`/enterprise/api/conversations/${thread.id}/export`)).status()).toBe(404);
  } finally {
    await page.request.post(`/enterprise/api/projects/${f.projectId}/members`,{headers,data:{userId:f.memberId}});
    await member.close();
  }
});
test("source viewer preserves document versions and renders HTML as text", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}/files`,
  );
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const headers = {
    origin: f.origin,
    "x-csrf-token": session.csrfToken,
  };
  async function upload(name, text, mimeType = "text/plain") {
    const response = await page.request.post("/enterprise/api/files/upload", {
      headers,
      multipart: {
        orgId: f.orgId,
        projectId: f.projectId,
        file: {
          name,
          mimeType,
          buffer: Buffer.from(text),
        },
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
    `/enterprise/api/files/${file.id}/content?projectId=${f.projectId}`,
  );
  const versionId = content.headers()["x-file-version"];
  expect(versionId).toBeTruthy();
  await page.reload();
  await page
    .getByRole("link", {
      name: "versioned-evidence.txt",
      exact: true,
    })
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
    `/enterprise/organizations/${f.orgId}/source/${file.id}?projectId=${f.projectId}&versionId=${versionId}`,
  );
  await expect(
    page.getByText("Saved document version", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("pre.text-preview")).toHaveText(
    "Original version evidence.",
  );
  const html =
    "<html><script>window.__unsafeSourceExecuted = true</script><h1>Uploaded HTML source</h1></html>";
  const unsafeFile = await upload("source-code.html", html, "text/html");
  await page.goto(
    `/enterprise/organizations/${f.orgId}/source/${unsafeFile.id}?projectId=${f.projectId}`,
  );
  await expect(page.locator("pre.text-preview")).toHaveText(html);
  expect(
    await page.evaluate(() => window.__unsafeSourceExecuted),
  ).toBeUndefined();
  await expect(
    page.getByRole("heading", {
      name: "Uploaded HTML source",
    }),
  ).toHaveCount(0);
});
test("PDF source preview uses a bounded blob and preserves the citation page", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}/files`,
  );
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const headers = {
    origin: f.origin,
    "x-csrf-token": session.csrfToken,
  };
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
  const response = await page.request.post("/enterprise/api/files/upload", {
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
    `/enterprise/api/files/${file.id}/content?projectId=${f.projectId}`,
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
    `/enterprise/organizations/${f.orgId}/source/${file.id}?projectId=${f.projectId}&versionId=${version}&page=1`,
  );
  const frame = page.locator("iframe.pdf-preview");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute(
    "src",
    new RegExp(
      `^blob:${f.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.+#page=1$`,
    ),
  );
  await expect(
    page.getByText("Saved document version · Page 1", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__cspViolation)).toBeUndefined();
  expect(violations).toEqual([]);
  await page.screenshot({
    path: `${evidence}/source-preview-desktop.png`,
    fullPage: true,
  });
});

// Capture browser failures privately; intentional response-error fixtures are covered above.
test.beforeEach(async ({ page }, testInfo) => {
  const errors = [],
    consoleErrors = [],
    responses = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push({
        text: message.text(),
        location: message.location().url,
      });
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      responses.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
  testInfo.browserEvidence = {
    errors,
    consoleErrors,
    responses,
  };
});
test.afterEach(async ({}, testInfo) => {
  const value = testInfo.browserEvidence;
  await writeFile(
    `${evidence}/${testInfo.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 150)}-console.json`,
    JSON.stringify(value, null, 2),
  );
  expect(value.errors).toEqual([]);
  // Only these deliberately injected error responses exercise recovery UI.
  const expected = testInfo.title.startsWith("zero-org owner")
    ? new Set([
        "503 /enterprise/api/me",
        "500 /enterprise/api/password-reset/request",
      ])
    : testInfo.title.startsWith("organization settings hub")
      ? new Set([
          "503 /enterprise/api/organizations/fixture/inference/accounts",
        ])
      : new Set();
  const unexpected = value.responses.filter(
    (r) => !expected.has(`${r.status} ${r.path}`),
  );
  expect(unexpected).toEqual([]);
  expect(
    value.consoleErrors.filter(
      (e) =>
        !e.text.startsWith(
          "Failed to load resource: the server responded with a status of",
        ),
    ),
  ).toEqual([]);
});
test("activation and reset stay under enterprise; one account switches organizations and administrator authority stays scoped", async ({
  page,
  browser,
}) => {
  const f = await ensureFixture(page),
    session = await (await page.request.get("/enterprise/api/session")).json(),
    headers = {
      origin: f.origin,
      "x-csrf-token": session.csrfToken,
    };
  const email = "multi-org-browser@example.test",
    invite = await page.request.post(
      `/enterprise/api/organizations/${f.orgId}/invitations`,
      {
        headers,
        data: {
          name: "Multi Org Analyst",
          email,
          role: "member",
        },
      },
    );
  expect(invite.status()).toBe(202);
  const activation = await invite.json();
  expect(new URL(activation.activationUrl).pathname).toBe(
    "/enterprise/activate",
  );
  const context = await browser.newContext({
      baseURL: f.origin,
      storageState: {
        cookies: [],
        origins: [],
      },
    }),
    member = await context.newPage();
  try {
    await member.goto(activation.activationUrl);
    await expect(
      member.getByRole("heading", {
        name: "Set up your account",
      }),
    ).toBeVisible();
    await member
      .getByLabel("Password", {
        exact: true,
      })
      .fill("synthetic browser activation password");
    await member
      .getByRole("button", {
        name: "Activate account",
      })
      .click();
    await expect(
      member.getByRole("heading", {
        name: "Workspaces",
        exact: true,
      }),
    ).toBeVisible();
    expect(new URL(member.url()).pathname).toMatch(/^\/enterprise\//);
    const cookie = (await context.cookies()).find(
      (c) => c.name === "wme_session",
    );
    expect(cookie.path).toBe("/enterprise");
    expect(cookie.httpOnly).toBe(true);
    await member.goto(`/enterprise/organizations/${f.orgId}/library`);
    await expect(
      member.getByRole("button", {
        name: "New folder",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.goto(`/enterprise/organizations/${f.orgId}/settings/members`);
    await page
      .getByRole("row", {
        name: new RegExp(email),
      })
      .getByRole("button", {
        name: "Edit",
        exact: true,
      })
      .click();
    await expect(page.getByLabel("Organization Files access")).toHaveCount(0);
    await page.getByRole("dialog").getByLabel("Role", { exact: true }).selectOption("admin");
    await page
      .getByRole("dialog")
      .getByRole("button", {
        name: "Save",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await member.reload();
    await expect(
      member.getByRole("button", {
        name: "New folder",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      member.getByRole("link", {
        name: "Settings",
        exact: true,
      }),
    ).toBeVisible();
    const second = await (
      await page.request.post("/enterprise/api/organizations", {
        headers,
        data: {
          name: "Browser second membership",
        },
      })
    ).json();
    const added = await page.request.post(
      `/enterprise/api/organizations/${second.id}/invitations`,
      {
        headers,
        data: {
          name: "Unchanged",
          email,
          role: "member",
        },
      },
    );
    expect(added.status()).toBe(201);
    expect((await added.json()).activationUrl).toBeUndefined();
    await member.goto("/enterprise");
    await expect(
      member.getByRole("heading", {
        name: "Your organizations",
      }),
    ).toBeVisible();
    await member
      .getByRole("link", {
        name: "Browser second membership",
        exact: true,
      })
      .click();
    await expect(
      member.getByRole("link", {
        name: "Your organizations",
      }),
    ).toBeVisible();
    await member
      .getByRole("link", {
        name: "Organization Files",
        exact: true,
      })
      .click();
    await expect(
      member.getByRole("button", {
        name: "New folder",
        exact: true,
      }),
    ).toHaveCount(0);
    await member
      .getByRole("button", {
        name: "Sign out",
        exact: true,
      })
      .click();
    await member.goto("/enterprise/forgot-password");
    await expect(
      member.getByRole("heading", {
        name: "Reset your password",
      }),
    ).toBeVisible();
    await member
      .getByLabel("Email", {
        exact: true,
      })
      .fill(email);
    const resetQueued = member.waitForResponse(
      (r) =>
        r.url().endsWith("/enterprise/api/password-reset/request") &&
        r.request().method() === "POST",
    );
    await member
      .getByRole("button", {
        name: "Send reset link",
      })
      .click();
    expect((await resetQueued).status()).toBe(202);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.database, {
      readOnly: true,
    });
    let reset;
    try {
      const rows = db
        .prepare(
          "SELECT payload FROM jobs WHERE type='password_reset.deliver' ORDER BY created_at DESC",
        )
        .all();
      reset = rows
        .map((r) => JSON.parse(r.payload))
        .find((r) => r.email === email).resetUrl;
    } finally {
      db.close();
    }
    expect(new URL(reset).pathname).toBe("/enterprise/reset-password");
    await member.goto(reset);
    await expect(
      member.getByRole("heading", {
        name: "Choose a new password",
      }),
    ).toBeVisible();
    await member
      .getByLabel("Password", {
        exact: true,
      })
      .fill("synthetic browser reset password");
    await member
      .getByRole("button", {
        name: "Reset password",
        exact: true,
      })
      .click();
    await expect(
      member.getByRole("heading", {
        name: "Your organizations",
      }),
    ).toBeVisible();
    expect(
      (
        await page.request.delete(
          `/enterprise/api/organizations/${second.id}/members/${activation.user.id}`,
          {
            headers,
          },
        )
      ).status(),
    ).toBe(200);
    await member.goto("/enterprise");
    await expect(
      member.getByRole("heading", {
        name: "Workspaces",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (
        await member.request.get(`/enterprise/api/organizations/${second.id}`)
      ).status(),
    ).toBe(404);
  } finally {
    await context.close();
  }
});
test("deleted-project administration recovers files and restores the original workspace", async ({
  page,
}) => {
  const f = await ensureFixture(page),
    session = await (await page.request.get("/enterprise/api/session")).json(),
    headers = {
      origin: f.origin,
      "x-csrf-token": session.csrfToken,
    };
  const response = await page.request.post(
    `/enterprise/api/organizations/${f.orgId}/projects`,
    {
      headers,
      data: {
        name: "Browser recovery workspace",
      },
    },
  );
  expect(response.status()).toBe(202);
  const project = await response.json();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/enterprise/api/projects/${project.id}`)
          ).json()
        ).status,
    )
    .toBe("ready");
  expect(
    (
      await page.request.post("/enterprise/api/files/upload", {
        headers,
        multipart: {
          orgId: f.orgId,
          projectId: project.id,
          files: {
            name: "recovery.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("recoverable browser fixture"),
          },
        },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.delete(`/enterprise/api/projects/${project.id}`, {
        headers,
      })
    ).status(),
  ).toBe(202);
  expect(
    (await page.request.get(`/enterprise/api/projects/${project.id}`)).status(),
  ).toBe(404);
  await page.goto(`/enterprise/organizations/${f.orgId}/settings`);
  await page
    .getByRole("link", {
      name: /Deleted workspaces/,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Deleted workspaces",
      exact: true,
    }),
  ).toBeVisible();
  const row = page.getByRole("row", {
    name: /Browser recovery workspace/,
  });
  await row
    .getByRole("button", {
      name: "Recover files to library",
    })
    .click();
  await expect(page.getByText(/Files recovered to Library/)).toBeVisible();
  await page.screenshot({
    path: `${evidence}/deleted-projects-desktop.png`,
    fullPage: true,
  });
  await row
    .getByRole("button", {
      name: "Restore",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Workspace restored.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${project.id}/files`,
  );
  await expect(
    page.getByText("recovery.txt", {
      exact: true,
    }),
  ).toBeVisible();
});

test("organization assets start without projects from Files and Assets, remain private, and retain revisions", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const f = await ensureFixture(page),
    session = await (await page.request.get("/enterprise/api/session")).json();
  const headers = { origin: f.origin, "x-csrf-token": session.csrfToken };
  const org = await (
    await page.request.post("/enterprise/api/organizations", {
      headers,
      data: { name: "Asset-only organization" },
    })
  ).json();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`/enterprise/organizations/${org.id}/library`);
  await expect(
    page.getByRole("heading", { name: "Organization Files", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New asset", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Organization overview");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Prepared without a project");
  await expect(page.getByLabel("Belongs to")).toHaveValue("");
  await page.getByRole("button", { name: "Create asset", exact: true }).click();
  await expect(page.getByLabel("Session permissions", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await choose(page, "Conversation model", "synthetic-asset-pi");
  await page
    .getByLabel("Message your agent", { exact: true })
    .fill("Prepare an overview with a useful generated data table.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Draft preview"]')
      .getByText("First version for review", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByText("Asset draft saved.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="Draft preview"]')
      .locator("script,object,embed,form"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const preview = await page
    .getByRole("link", { name: "Preview draft" })
    .getAttribute("href");
  const anonymous = await browser.newContext({
    baseURL: f.origin,
    storageState: { cookies: [], origins: [] },
  });
  expect((await anonymous.request.get(preview)).status()).toBe(401);
  expect(
    (await anonymous.request.get(preview.replace(/\/preview$/, ""))).status(),
  ).toBe(404);
  const draft = await page.context().newPage();
  await draft.goto(preview);
  await expect(draft.getByText("First version for review")).toBeVisible();
  await draft.close();
  await page.screenshot({
    path: `${evidence}/asset-create-desktop.png`,
    fullPage: true,
  });
  await page.getByLabel("Visibility").selectOption("public");
  await page
    .getByRole("button", { name: "Publish asset", exact: true })
    .click();
  const url = await page
    .getByRole("link", { name: "Open published asset" })
    .getAttribute("href");
  expect((await anonymous.request.get(url)).status()).toBe(200);
  await page.getByRole("button", { name: "Prepare", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message your agent", exact: true })
    .fill("Revise the overview and its generated data.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Draft preview"]')
      .getByText("Second draft kept private", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect
    .poll(async () =>
      (await (await anonymous.request.get(url)).text()).includes(
        "Second draft",
      ),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page
    .getByRole("button", { name: "Publish new version", exact: true })
    .click();
  await page.getByRole("button", { name: "Versions", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore version 1 to draft", exact: true })
    .click();
  await expect(
    page
      .frameLocator('iframe[title="Draft preview"]')
      .getByText("First version for review", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${evidence}/asset-edit-mobile.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "New asset", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "New asset", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await anonymous.close();
  expect(errors).toEqual([]);
});

test("remote subscription screens resume without another grant and discriminate provider handoffs", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const provider of ["openai", "anthropic", "xai"]) {
    await page.goto(`/enterprise/organizations/${f.orgId}/connections`);
    await expect(
      page.getByRole("heading", { name: "Connections", exact: true }),
    ).toBeVisible();
    await page
      .locator("header.page-header")
      .getByRole("button", { name: "Add connection", exact: true })
      .click();
    await page.getByLabel("Connection type").selectOption("subscription");
    await page.getByLabel("Provider", { exact: true }).selectOption(provider);
    if (provider === "anthropic") await page.getByRole("checkbox").check();
    const start = page.waitForResponse(
      (r) =>
        r.url().endsWith("/inference/oauth") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Begin sign in", exact: true })
      .click();
    const attempt = await (await start).json();
    await expect(
      page.getByRole("link", { name: "Continue to provider" }),
    ).toBeVisible();
    expect(
      await page
        .getByRole("link", { name: "Continue to provider" })
        .getAttribute("href"),
    ).not.toContain("localhost");
    if (provider === "anthropic") {
      await expect(page.getByLabel("Authorization code")).toBeVisible();
      await expect(page.getByText("Device code", { exact: true })).toHaveCount(
        0,
      );
    } else {
      await expect(page.getByText("TEST-CODE", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Authorization code")).toHaveCount(0);
    }
    await expect(page.getByLabel("Callback URL")).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/signin-${provider}-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `${evidence}/signin-${provider}-mobile.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.reload();
    await page
      .getByRole("button", { name: "View sign-in", exact: true })
      .click();
    const pending = await (
      await page.request.get(
        `/enterprise/api/organizations/${f.orgId}/inference/oauth`,
      )
    ).json();
    expect(
      pending.items
        .filter((s) => s.provider === provider && s.status === "pending")
        .map((s) => s.id),
    ).toEqual([attempt.id]);
    if (provider === "anthropic") {
      await page
        .getByLabel("Authorization code")
        .fill("fixture-authorization-code");
      await page
        .getByRole("button", { name: "Complete sign in", exact: true })
        .click();
    } else
      await writeFile(
        `${evidence}/provider-control.json`,
        JSON.stringify({ [attempt.id]: "ready" }),
      );
    await expect(
      page.getByText("Connection saved.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.setViewportSize({ width: 1536, height: 1024 });
  }
  expect(errors).toEqual([]);
});

test("denied, expired and unavailable remote sign-ins offer a fresh attempt without stale codes", async ({
  page,
}) => {
  const f = await ensureFixture(page),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const state of ["denied", "expired", "error"]) {
    await page.goto(`/enterprise/organizations/${f.orgId}/connections`);
    await page
      .locator("header.page-header")
      .getByRole("button", { name: "Add connection", exact: true })
      .click();
    await page.getByLabel("Connection type").selectOption("subscription");
    await page.getByLabel("Provider", { exact: true }).selectOption("openai");
    const start = page.waitForResponse(
      (r) =>
        r.url().endsWith("/inference/oauth") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Begin sign in", exact: true })
      .click();
    const attempt = await (await start).json();
    await writeFile(
      `${evidence}/provider-control.json`,
      JSON.stringify({ [attempt.id]: state }),
    );
    await expect(
      page.getByRole("button", { name: "Start a new sign-in", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Continue to provider" }),
    ).toHaveCount(0);
    await expect(page.getByText("TEST-CODE", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Start a new sign-in", exact: true })
      .click();
    await page.getByLabel("Connection type").selectOption("subscription");
    const retry = page.waitForResponse(
      (r) =>
        r.url().endsWith("/inference/oauth") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Begin sign in", exact: true })
      .click();
    expect((await (await retry).json()).id).not.toBe(attempt.id);
    await page
      .getByRole("button", { name: "Cancel sign in", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("native streaming retains chronological work, task progress, full copy and reopen history", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const detailRequests = [];
  page.on("request", (request) => {
    if (/\/activities\/[^/?]+\/[^/?]+/.test(request.url()))
      detailRequests.push(request.url());
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(
    "/enterprise/organizations/" + f.orgId + "/workspaces/" + f.projectId,
  );
  await page
    .getByRole("link", { name: "New chat", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(page.locator(".composer-area .session-mode")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Conversation settings", exact: true })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Native streaming review");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await choose(page, "Conversation model", "gpt-test-fixture");
  await page
    .getByLabel("Message your agent")
    .fill("[native-stream] Inspect the record.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".native-task-badge")).toContainText(
    "Inspect the retained record",
  );
  await expect(page.locator(".native-commentary")).toContainText(
    "I will inspect",
  );
  expect(
    detailRequests.some((url) => url.includes("tool%3Afixture-read")),
  ).toBe(false);
  await page
    .locator(".native-work-group > summary")
    .filter({ hasText: "Using 1 tool" })
    .click();
  await page
    .locator(".native-work-item > summary")
    .filter({ hasText: "Read retained record" })
    .click();
  await expect(
    page.getByRole("button", { name: "Latest reply" }),
  ).toBeVisible();
  await page.screenshot({
    path: evidence + "/native-streaming-desktop.png",
    fullPage: true,
  });
  await expect(page.locator(".native-final")).toContainText(
    "All retained output remains available",
    { timeout: 15000 },
  );
  await expect(page.locator(".native-task-badge")).toHaveCount(0);
  await expect(page.locator(".native-completed-work")).toHaveAttribute(
    "open",
    "",
  );
  await page.getByRole("button", { name: "Copy response" }).click();
  await expect(page.locator(".response-actions")).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "The record is complete.\n\nAll retained output remains available after reopening this conversation.",
  );
  await page.reload();
  await page.getByRole("complementary", { name: "Workspace content", exact: true }).getByRole("link", { name: /Native streaming review/ }).click();
  await expect(page.locator(".native-final")).toContainText(
    "All retained output remains available",
  );
  await page.locator(".native-completed-work > summary").click();
  await page
    .locator(".native-work-group > summary")
    .filter({ hasText: "Used 1 tool" })
    .click();
  await page
    .locator(".native-work-item > summary")
    .filter({ hasText: "Read retained record" })
    .click();
  await expect(page.locator(".native-work-detail")).toContainText(
    "Complete tool output.",
  );
  await expect(
    page.getByRole("button", { name: "Load more details" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more details" }).click();
  await expect(page.locator(".native-work-detail")).toContainText(
    "FINAL RETAINED ROW",
  );
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Native history", exact: true })
    .click();
  await page.getByRole("button", { name: "Search history" }).click();
  await expect(page.locator(".native-history-results")).toContainText(
    "message",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: evidence + "/native-streaming-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Conversation settings" }).click();
  await expect(
    page.getByLabel("Pi Durable SDK version", { exact: true }),
  ).toHaveValue("fixture-sdk-one");
  await page
    .getByLabel("Pi Durable SDK version", { exact: true })
    .selectOption("fixture-sdk-two");
  await page
    .getByRole("button", { name: "Apply version", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply version", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(
    page.getByLabel("Pi Durable SDK version", { exact: true }),
  ).toHaveValue("fixture-sdk-two");
  expect(errors).toEqual([]);
});

test("older replies outside the activity window expose complete text and their paged work", async ({
  page,
}) => {
  test.skip(
    Boolean(process.env.WME_E2E_AGENT_IMAGE),
    "Uses the disposable API history fixture; native protocols have their own acceptance suite.",
  );
  const f = await ensureFixture(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}`,
  );
  await page
    .getByRole("link", { name: "New chat", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Conversation settings", exact: true })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Retained reply recovery");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await choose(page, "Conversation model", "gpt-test-fixture");
  await page
    .getByLabel("Message your agent")
    .fill("[retained-reply] Generate an older complete reply.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".native-final")).toContainText(
    "END OF OLDER REPLY",
  );
  await page
    .getByLabel("Message your agent")
    .fill("[history-page-after] Generate later work.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .locator(".native-final")
      .filter({ hasText: "Later activity is complete" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Stop background work", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page.reload();
  // Reopen the newest conversation through the project list.
  await page
    .getByRole("link", { name: /Retained reply recovery/ })
    .first()
    .click();
  const older = page.locator("article.message-assistant").first();
  await expect(
    older.getByRole("button", { name: "Show complete reply", exact: true }),
  ).toBeVisible();
  await older
    .getByRole("button", { name: "Show complete reply", exact: true })
    .click();
  await expect(older).toContainText("END OF OLDER REPLY");
  await older
    .getByRole("button", { name: "Copy response", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Retained older response. ".repeat(100) + "END OF OLDER REPLY",
  );
  const complete = page
    .locator("article.message-assistant")
    .filter({ hasText: "END OF OLDER REPLY" })
    .first();
  await complete
    .getByRole("button", { name: "Load complete activity", exact: true })
    .click();
  await expect(complete.locator(".native-final")).toContainText(
    "END OF OLDER REPLY",
  );
  await expect(
    complete.getByRole("button", {
      name: "Load complete activity",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.screenshot({
    path: evidence + "/retained-reply-recovery.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("responsive desktop rails leave chat usable and preserves URL selection and scoped drafts", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const headers = { origin: f.origin, "x-csrf-token": session.csrfToken };
  const base = `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}`;
  const first = await (
    await page.request.post(
      `/enterprise/api/projects/${f.projectId}/conversations`,
      {
        headers,
        data: { title: "Workspace layout review", model: "gpt-test-fixture" },
      },
    )
  ).json();
  const second = await (
    await page.request.post(
      `/enterprise/api/projects/${f.projectId}/conversations`,
      {
        headers,
        data: {
          title: "Read-only research",
          mode: "read",
          model: "gpt-test-fixture",
        },
      },
    )
  ).json();
  expect(first.mode).toBe("write");
  expect(second.mode).toBe("write");
  await page.setViewportSize({ width: 855, height: 769 });
  await page.goto(`${base}?conversation=${first.id}`);
  await expect(page.locator(".conversation-main > h2")).toHaveText(
    "Workspace layout review",
  );
  await expect(page.locator(".conversation-rail")).toHaveCount(0);
  const geometry = await page.locator(".conversation-main").boundingBox();
  await expect(page.getByRole("complementary", { name: "Workspace content" })).not.toBeVisible();
  expect(geometry.width).toBeGreaterThan(500);
  const header = await page.locator(".platform-header").boundingBox();
  expect(geometry.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(geometry.height).toBeGreaterThan(500);
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(769);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  const rail = await page.locator(".sidebar").elementHandle();
  const draft = page.getByLabel("Message your agent");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar-backdrop")).toHaveCount(0);
  async function showNavigation() {
    const reveal = page.getByRole("button", { name: "Show navigation sidebar", exact: true });
    if (await reveal.isVisible()) await reveal.click();
    const back = page.getByRole("button", { name: "Back to workspace navigation", exact: true });
    if (await back.isVisible()) await back.click();
    await expect(page.locator(".sidebar")).toBeVisible();
  }
  await draft.fill("Keep this unsent project draft");
  await showNavigation();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Workspace Files", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workspace Files", exact: true }),
  ).toBeVisible();
  expect(await rail.evaluate((node) => node.isConnected)).toBe(true);
  await showNavigation();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Workspace layout review", exact: true })
    .click();
  await expect(draft).toHaveValue("Keep this unsent project draft");
  await page.reload();
  await expect(draft).toHaveValue("Keep this unsent project draft");
  await expect(page).toHaveURL(url => url.origin === f.origin && url.pathname === base
    && url.searchParams.get("folder") === "all" && url.searchParams.get("conversation") === first.id);
  await showNavigation();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Read-only research", exact: true })
    .click();
  await expect(draft).toHaveValue("");
  await expect(page.locator(".session-mode")).toHaveCount(0);
  await expect(draft).toBeEnabled();
  await page.goBack();
  await expect(page.locator(".conversation-main > h2")).toHaveText(
    "Workspace layout review",
  );
  await expect(draft).toHaveValue("Keep this unsent project draft");
  // Adaptive opens contents on folder selection, then expands that same page
  // beside navigation when the viewport has room for both rails.
  await page.locator(".sidebar").getByRole("link", { name: "All Workspaces", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Workspace content" })).toBeVisible();
  await expect(draft).toHaveValue("Keep this unsent project draft");
  await page.screenshot({ path: `${evidence}/workspace-855.png` });
  await page.setViewportSize({ width: 1536, height: 1024 });
  await expect(page.getByRole("complementary", { name: "Workspace content" })).toBeVisible();
  await page.screenshot({ path: `${evidence}/workspace-wide.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(draft).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  const modelControls = await page
    .locator(".composer-model-controls > button")
    .evaluateAll((labels) =>
      labels.map((label) => {
        const r = label.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
  expect(modelControls.length).toBe(2);
  expect(
    modelControls[0].right <= modelControls[1].left ||
      modelControls[0].bottom <= modelControls[1].top,
  ).toBe(true);
  await showNavigation();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Read-only research", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
  await expect(page.locator(".conversation-main > h2")).toHaveText(
    "Read-only research",
  );
  await page.screenshot({ path: `${evidence}/workspace-mobile.png` });
  expect(errors).toEqual([]);
});

test("a successful send acknowledged after navigation cannot restore an already-sent draft", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const response = await page.request.post(
    `/enterprise/api/projects/${f.projectId}/conversations`,
    {
      headers: { origin: f.origin, "x-csrf-token": session.csrfToken },
      data: { title: "Delayed receipt review", model: "gpt-test-fixture" },
    },
  );
  const conversation = await response.json();
  const base = `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}`;
  await page.goto(`${base}?conversation=${conversation.id}`);
  let released = false;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let admitted;
  const seen = new Promise((resolve) => {
    admitted = resolve;
  });
  await page.route(
    `**/api/conversations/${conversation.id}/messages`,
    async (route) => {
      if (route.request().method() !== "POST") {
        if (!released)
          return route.fulfill({
            json: { items: [], hasMore: false, nextBefore: null },
          });
        return route.continue();
      }
      const result = await route.fetch();
      admitted();
      await held;
      await route.fulfill({ response: result });
    },
  );
  await page
    .getByLabel("Message your agent")
    .fill("An exact receipt acknowledged after navigation");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await seen;
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Workspace Files", exact: true })
    .click();
  const settled = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/conversations/${conversation.id}/messages`) &&
      r.request().method() === "POST",
  );
  released = true;
  release();
  await settled;
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Delayed receipt review", exact: true })
    .click();
  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  await expect(
    page.getByText("An exact receipt acknowledged after navigation", {
      exact: true,
    }),
  ).toHaveCount(1);
});

test("composer thinking choices follow each model and clear the previous override", async ({
  page,
}) => {
  const f = await ensureFixture(page);
  const session = await (
    await page.request.get("/enterprise/api/session")
  ).json();
  const headers = { origin: f.origin, "x-csrf-token": session.csrfToken };
  const response = await page.request.post(
    `/enterprise/api/projects/${f.projectId}/conversations`,
    {
      headers,
      data: {
        title: "Model thinking controls",
        mode: "write",
        model: "gpt-test-fixture",
      },
    },
  );
  expect(response.status()).toBe(201);
  const c = await response.json();
  await page.goto(
    `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}?conversation=${c.id}&folder=all`,
  );
  const thinking = picker(page, "Thinking level");
  const model = picker(page, "Conversation model");
  // The popout carries a title-case heading and full option labels.
  await thinking.click();
  await expect(page.getByText("Thinking Level", { exact: true })).toBeVisible();
  await expect(page.getByRole("option")).toHaveText([
    "Model default",
    "Off",
    "Low",
    "High",
  ]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(thinking).toBeFocused();
  await choose(page, "Thinking level", "high");
  await expect(thinking).toHaveAttribute("data-value", "high");
  // A confirmed PATCH must drive the controls even while canonical refresh waits.
  let releaseRefresh, heldReads = 0;
  const pendingRefresh = new Promise(resolve => { releaseRefresh = resolve; });
  const detailPath = `**/enterprise/api/conversations/${c.id}`;
  const holdRefresh = async route => {
    if (route.request().method() === "GET") { heldReads++; await pendingRefresh; }
    return route.continue();
  };
  await page.route(detailPath, holdRefresh);
  try {
    await choose(page, "Conversation model", "mandatory-thinking-fixture");
    await expect.poll(() => heldReads).toBeGreaterThan(0);
    await expect(model).toHaveAttribute("data-value", "mandatory-thinking-fixture");
    await expect(thinking).toHaveAttribute("data-value", "");
    await thinking.click();
    await expect(page.getByRole("option")).toHaveText(["Model default", "Low", "High", "Max"]);
    await page.keyboard.press("Escape");
  } finally {
    releaseRefresh();
  }
  await choose(page, "Thinking level", "max");
  await expect(thinking).toHaveAttribute("data-value", "max");
  expect((await (await page.request.get(`/enterprise/api/conversations/${c.id}`)).json()).pi.thinking).toBe("max");
  await choose(page, "Thinking level", "");
  await expect(thinking).toHaveAttribute("data-value", "");
  expect((await (await page.request.get(`/enterprise/api/conversations/${c.id}`)).json()).pi.thinking).toBeUndefined();
  await choose(page, "Conversation model", "no-thinking-fixture");
  await expect(thinking).toHaveAttribute("data-value", "");
  await expect(thinking).toBeDisabled();
  const stored = await (
    await page.request.get(`/enterprise/api/conversations/${c.id}`)
  ).json();
  expect(stored.pi.thinking).toBeUndefined();
});


test("expanded Markdown survives a real local SSE background comment and canonical read", async ({ page }) => {
  const f = await ensureFixture(page);
  const session = await (await page.request.get("/enterprise/api/session")).json();
  const headers = { origin: f.origin, "x-csrf-token": session.csrfToken };
  const response = await page.request.post(`/enterprise/api/projects/${f.projectId}/conversations`, {
    headers, data: { title: "Canonical table refresh", model: "gpt-test-fixture" },
  });
  expect(response.status()).toBe(201);
  const conversation = await response.json();
  let canonicalReads = 0;
  await page.route(`**/api/conversations/${conversation.id}/messages?*`, async route => {
    const result = await route.fetch();
    const body = await result.json();
    canonicalReads++;
    // Keep local durable IDs, revisions, authority and real SSE. Only substitute
    // a deterministic Markdown body so table state is observable.
    body.items = body.items.map(message => message.role === "assistant" ? {
      ...message, content: "| Canonical record | Count |\n| --- | --- |\n| Retained table | 8 |",
    } : message);
    await route.fulfill({ response: result, json: body });
  });
  await page.goto(`/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}?conversation=${conversation.id}`);
  await page.getByLabel("Message your agent").fill("Create the synthetic retained response");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  const table = page.getByRole("dialog", { name: "Table", exact: true });
  await expect(table).toBeVisible();
  const before = canonicalReads;
  const comment = await page.request.post(`/enterprise/api/conversations/${conversation.id}/messages`, {
    headers, data: { content: "An independently arriving canonical comment", kind: "comment", requestId: "parity-background-comment" },
  });
  expect(comment.ok(), await comment.text()).toBe(true);
  await expect(page.getByText("An independently arriving canonical comment", { exact: true })).toBeAttached();
  expect(canonicalReads).toBeGreaterThan(before);
  await expect(table).toBeVisible();
  await expect(table.getByRole("cell", { name: "Retained table", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(table).toHaveCount(0);
});

test("appearance belongs to the user's Personal settings across workspaces without changing teammates", async ({ page, browser }) => {
  const f = await ensureFixture(page);
  const teammate = await browser.newContext({ storageState: `${evidence}/org-admin-auth.json` });
  try {
    const original = (await (await page.request.get('/enterprise/api/me')).json()).user;
    const teammateBefore = (await (await teammate.request.get(`${f.origin}/enterprise/api/me`)).json()).user;
    const settingsPath = `/enterprise/organizations/${f.orgId}/workspaces/${f.projectId}/settings`;
    await page.goto(settingsPath);
    await expect(page.getByLabel('Default agent', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Theme', { exact: true })).toHaveCount(0);
    await page.locator('.platform-header').getByRole('link', { name: 'Personal settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toHaveCount(1);
    const mutations = [];
    page.on('request', request => { if (['POST', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(new URL(request.url()).pathname); });
    await page.getByRole('radio', { name: 'Dark theme', exact: true }).check();
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByText('Profile updated.', { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('link', { name: 'Back to organization', exact: true }).click();
    await expect(page).toHaveURL(new URL(settingsPath, f.origin).href);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto(`/enterprise/organizations/${f.orgId}/workspaces`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(mutations).toEqual(['/enterprise/api/me']);
    const teammateAfter = (await (await teammate.request.get(`${f.origin}/enterprise/api/me`)).json()).user;
    expect(teammateAfter.theme).toBe(teammateBefore.theme);
    await page.locator('.platform-header').getByRole('link', { name: 'Personal settings', exact: true }).click();
    await page.getByRole('radio', { name: `${original.theme[0].toUpperCase()}${original.theme.slice(1)} theme`, exact: true }).check();
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByText('Profile updated.', { exact: true })).toBeVisible();
  } finally { await teammate.close(); }
});
