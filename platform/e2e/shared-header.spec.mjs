import { test, expect } from '@playwright/test';
import { parityFixture, org, project, folder, base, workspace } from './ui-parity.fixture.mjs';

test.use({ storageState: { cookies: [], origins: [] } });

async function setup(page, baseURL, { role = 'owner', orgRole = 'member', count = 1 } = {}) {
  const state = await parityFixture(page, { baseURL });
  const user = { id: 'parity-owner', role, name: 'Synthetic colleague', email: 'synthetic@example.test', theme: 'green' };
  const organizations = Array.from({ length: count }, (_, index) => ({ ...org, id: index ? `other-${index}` : org.id, name: index ? `Organization ${index + 1}` : org.name, role: orgRole }));
  state.errors = [];
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.errors.push(message.text()); });
  await page.route('**/enterprise/api/**', route => {
    const path = new URL(route.request().url()).pathname.slice('/enterprise/api'.length);
    if (path === '/session') return route.fulfill({ json: { user, csrfToken: 'synthetic' } });
    if (path === '/organizations') return route.fulfill({ json: { items: organizations } });
    if (path === '/me') return route.fulfill({ json: { user, organizations, projects: [] } });
    if (path === '/platform/settings') return route.fulfill({ json: { owner: user, organizations: count, accounts: 1, hosts: [] } });
    return route.fallback();
  });
  return state;
}

async function header(page, { owner, count = 1 }) {
  const top = page.locator('.platform-header');
  await expect(top).toHaveCount(1);
  await expect(top).toBeVisible();
  await expect(top.getByRole('link', { name: 'WovenMatter Enterprise Platform', exact: true })).toBeVisible();
  await expect(page.locator('a a')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Personal settings', exact: true })).toHaveCount(1);
  await expect(top.getByRole('link', { name: 'Personal settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
  await expect(top.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar a[href*="personal-settings"], .sidebar-footer')).toHaveCount(0);
  for (const name of ['Accounts', 'Platform settings']) await expect(top.getByRole('link', { name, exact: true })).toHaveCount(owner ? 1 : 0);
  if (!owner) await expect(top.getByRole('link', { name: count === 1 ? org.name : 'Your organizations', exact: true })).toBeVisible();
}

for (const scenario of [
  { name: 'owner', role: 'owner', orgRole: 'admin', count: 1 },
  { name: 'organization admin', role: 'member', orgRole: 'admin', count: 1 },
  { name: 'member', role: 'member', orgRole: 'member', count: 1 },
  { name: 'multi-organization member', role: 'member', orgRole: 'member', count: 2 },
]) test(`${scenario.name}: shared navigation and workspace settings round-trip`, async ({ page, baseURL }, testInfo) => {
  const state = await setup(page, baseURL, scenario);
  const owner = scenario.role === 'owner';
  const check = () => header(page, { owner, count: scenario.count });
  const root = owner || scenario.count > 1 ? '/enterprise/' : `${base}/workspaces`;
  await page.goto('/enterprise/');
  await expect(page).toHaveURL(new URL(root, baseURL).href);
  await check();
  if (owner) for (const path of ['/enterprise/accounts', '/enterprise/platform-settings']) {
    await page.goto(path); await check(); await expect(page.locator('main h1')).toBeVisible();
  }
  if (!owner) for (const path of ['/enterprise/accounts', '/enterprise/platform-settings']) {
    await page.goto(path); await expect(page).toHaveURL(url => url.pathname.replace(/\/$/, "") === root.replace(/\/$/, "")); await check();
  }
  await page.goto(`${base}/workspaces`); await check();
  const orgNav = page.getByRole('navigation', { name: 'Organization navigation' });
  await expect(orgNav.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(owner || scenario.orgRole === 'admin' ? 1 : 0);
  await page.goto(workspace); await check();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace.png`) });
  const settings = page.locator('.platform-header').getByRole('link', { name: 'Personal settings', exact: true });
  await settings.click(); await expect(page.getByRole('heading', { name: 'Personal settings', exact: true })).toBeVisible(); await check();
  const expectedReturn = workspace.replace('/enterprise', '');
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(expectedReturn);
  await settings.click(); // Clicking the global link again must not discard context.
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(expectedReturn);
  await page.getByRole('link', { name: 'Back to organization', exact: true }).click();
  await expect(page).toHaveURL(new URL(workspace, baseURL).href);
  await expect(page.getByRole('heading', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

for (const role of ['owner', 'member']) test(`${role}: mobile header, drawer and composer fit remaining viewport`, async ({ page, baseURL }, testInfo) => {
  const state = await setup(page, baseURL, { role });
  await page.goto(workspace);
  for (const width of [390, 760, 761, 1320]) {
    await page.setViewportSize({ width, height: 844 });
    await header(page, { owner: role === 'owner' });
    await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible();
    const geometry = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      return { header: rect('.platform-header'), main: rect('main'), composer: rect('.composer-area'), width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
    });
    expect(geometry.width).toBeLessThanOrEqual(width);
    expect(geometry.height).toBeLessThanOrEqual(844);
    expect(geometry.main.top).toBeGreaterThanOrEqual(geometry.header.bottom);
    expect(geometry.composer.bottom).toBeLessThanOrEqual(844);
    expect(geometry.composer.top).toBeGreaterThan(geometry.header.bottom);
    if (width < 640) {
      await page.getByRole('button', { name: 'Show navigation sidebar', exact: true }).click();
      if (await page.getByRole('button', { name: 'Back to workspace navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back to workspace navigation', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
      await expect(drawer).toBeVisible();
      await expect(page.locator('.platform-header')).toHaveAttribute('inert', '');
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      await expect(drawer.locator('a[href*="personal-settings"]')).toHaveCount(0);
      const recents = drawer.locator('.sidebar summary').filter({ hasText: /^Recents$/ });
      await recents.click(); // A collapsed final section is still part of keyboard navigation.
      const close = drawer.getByRole('button', { name: 'Hide navigation sidebar', exact: true });
      await close.focus(); await page.keyboard.press('Shift+Tab');
      await expect(recents).toBeFocused();
      await page.keyboard.press('Tab'); await expect(close).toBeFocused();
      await recents.click();
      await page.screenshot({ path: testInfo.outputPath(`${role}-drawer-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Show navigation sidebar', exact: true })).toBeFocused();
      await expect(page.locator('.platform-header')).not.toHaveAttribute('inert');
    }
    await page.screenshot({ path: testInfo.outputPath(`${role}-workspace-${width}.png`) });
  }
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('Agents and Folders are independent sections with working folder navigation', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  await page.goto(workspace);
  const rail = page.locator('.workspace-navigation');
  await expect(rail.locator(':scope > details > summary')).toHaveText(['Agents', 'Folders', 'Recents']);
  await expect(rail.locator('summary').filter({ hasText: project.name })).toHaveCount(0);
  await expect(rail.locator('.workspace-rail-title')).toHaveText(project.name);
  await rail.locator('summary').filter({ hasText: /^Agents$/ }).click();
  await expect(rail.getByRole('link', { name: 'Pi Durable', exact: true })).toBeHidden();
  await expect(rail.getByRole('link', { name: folder.name, exact: true })).toBeVisible();
  await rail.locator('summary').filter({ hasText: /^Agents$/ }).click();
  await rail.locator('summary').filter({ hasText: /^Folders$/ }).click();
  await expect(rail.getByRole('link', { name: folder.name, exact: true })).toBeHidden();
  await expect(rail.getByRole('link', { name: 'Pi Durable', exact: true })).toBeVisible();
  await rail.locator('summary').filter({ hasText: /^Folders$/ }).click();
  await rail.getByRole('link', { name: folder.name, exact: true }).click();
  await expect(page).toHaveURL(new URL(`${base}/workspaces/${project.id}?folder=${folder.id}&conversation=parity-chat`, baseURL).href);
  await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible();
  await rail.getByRole('link', { name: folder.name, exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('logout failure remains visible in the shared header and retry signs out', async ({ page, baseURL }) => {
  await setup(page, baseURL);
  let fail = true;
  await page.route('**/enterprise/api/logout', route => route.fulfill(fail
    ? { status: 503, json: { error: { message: 'Synthetic logout unavailable' } } }
    : { json: { ok: true } }));
  await page.goto(workspace);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('.platform-header').getByRole('alert')).toHaveText('Synthetic logout unavailable');
  fail = false;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
  await expect(page.locator('.platform-header')).toHaveCount(0);
});

test('right-panel Chats and Notes search retain All Workspaces and folder scope', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  const chats = [
    { id: 'parity-chat', title: 'Retained parity conversation', folderId: folder.id, harness: 'pi' },
    { id: 'other-chat', title: 'Other conversation', folderId: null, harness: 'pi' },
  ];
  const notes = [
    { id: 'folder-note', title: 'Folder research', folderId: folder.id, kind: 'note', data: {} },
    { id: 'other-note', title: 'Other research', folderId: null, kind: 'note', data: {} },
  ];
  await page.route('**/enterprise/api/projects/*/conversations', route => route.fulfill({ json: { items: chats } }));
  await page.route('**/enterprise/api/projects/*/workspace-content?kind=note', route => route.fulfill({ json: { items: notes } }));
  await page.goto(workspace);
  const content = page.getByRole('complementary', { name: 'Workspace content' });
  const rail = page.locator('.workspace-navigation');
  await expect(rail.getByRole('searchbox')).toHaveCount(0);
  await expect(content.getByRole('link', { name: 'Other conversation', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('no match');
  await expect(content.locator('.workspace-detail-list').getByRole('link')).toHaveCount(0);
  await expect(rail.getByRole('link', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('retained');
  await expect(content.getByRole('link', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('');
  await rail.getByRole('link', { name: folder.name, exact: true }).click();
  await expect(content.getByRole('link', { name: 'Other conversation', exact: true })).toHaveCount(0);
  await expect(content.getByRole('link', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  await content.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(content.getByRole('link', { name: 'Folder research', exact: true })).toBeVisible();
  await expect(content.getByRole('link', { name: 'Other research', exact: true })).toHaveCount(0);
  await content.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('other');
  await expect(content.getByRole('link', { name: 'Folder research', exact: true })).toHaveCount(0);
  await rail.getByRole('link', { name: 'All Workspaces', exact: true }).click();
  await expect(content.getByRole('link', { name: 'Other research', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('');
  await expect(content.getByRole('link', { name: 'Folder research', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});
