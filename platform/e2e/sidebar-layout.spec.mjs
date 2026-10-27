import { test, expect } from '@playwright/test';
import { parityFixture, base, workspace, project, folder, org } from './ui-parity.fixture.mjs';

// Browser plugin not available: use the repository's isolated Playwright fixture.
// Flow: Personal settings -> layout/side -> folder selection -> retained scoped
// content, collapse/reveal, route return, and responsive keyboard navigation.
test.use({ storageState: { cookies: [], origins: [] } });
const root = `${base}/workspaces/${project.id}`;
const key = 'wme:sidebar:v1:parity-owner';
const user = { id: 'parity-owner', role: 'owner', name: 'Synthetic owner', email: 'parity@example.test', theme: 'green' };
const prefs = (style, side = 'left') => ({ version: 1, style, side, navigationVisible: true, contentVisible: true, singleVisible: true });
async function setup(page, baseURL, preference) {
  const state = await parityFixture(page, { baseURL });
  await page.route('**/api/me', route => route.fulfill({ json: { user, organizations: [org], projects: [project] } }));
  if (preference) await page.addInitScript(({ key, preference }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(preference)); }, { key, preference });
  return state;
}
async function chooseLayout(page, title, side) {
  await page.locator(".platform-header").getByRole('link', { name: "Settings", exact: true }).click();
  await page.getByRole('radio', { name: new RegExp(`^${title}`) }).check();
  if (side) await page.getByRole('combobox', { name: 'Sidebar side' }).selectOption(side);
  await expect(page.getByText(/These device-local preferences are not synchronized/)).toBeVisible();
  await page.getByRole('link', { name: 'Back to organization', exact: true }).click();
}
const nav = page => page.locator('.sidebar');
const contents = page => page.getByRole('complementary', { name: 'Workspace content', exact: true });
const settled = page => page.evaluate(() => Promise.all([...document.querySelectorAll('.sidebar-layout,.sidebar,.sidebar-content-slot,#main')].flatMap(node => node.getAnimations()).map(animation => animation.finished.catch(() => {}))));
const x = async locator => { await settled(locator.page()); return (await locator.boundingBox()).x; };
const assertClean = state => { expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]); };

test('explicit split, independent collapse/reveal, reload and keyboard focus', async ({ page, baseURL }, testInfo) => {
  const state = await setup(page, baseURL, prefs('split'));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(workspace);
  await expect(page).toHaveTitle(/WovenMatter/);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style', 'split');
  await expect(nav(page)).toBeVisible(); await expect(contents(page)).toBeVisible();
  expect(await x(nav(page))).toBeLessThan(await x(page.locator('#main')));
  expect(await x(contents(page))).toBeGreaterThan(await x(page.locator('#main')));
  await page.getByRole('button', { name: 'Hide navigation sidebar' }).focus(); await page.keyboard.press('Enter');
  await expect(nav(page)).toBeHidden();
  const revealNav = page.getByRole('button', { name: 'Show navigation sidebar' });
  await expect(revealNav).toBeFocused();
  await page.getByRole('button', { name: 'Hide workspace sidebar' }).click();
  await expect(contents(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show workspace sidebar' })).toBeFocused();
  await page.reload(); await expect(nav(page)).toBeHidden(); await expect(contents(page)).toBeHidden();
  await page.getByRole('button', { name: 'Show navigation sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Hide navigation sidebar' })).toBeFocused();
  await expect(contents(page)).toBeHidden();
  await page.getByRole('button', { name: 'Show workspace sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Hide workspace sidebar' })).toBeFocused();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('split-restored.png') });
  expect(errors).toEqual([]); assertClean(state);
});

test('single replaces navigation, moves side, retains folder query and search through routes and settings', async ({ page, baseURL }, testInfo) => {
  const state = await setup(page, baseURL, prefs('single'));
  await page.goto(root);
  await expect(nav(page)).toBeVisible(); await expect(contents(page)).toBeHidden();
  await nav(page).getByRole('link', { name: folder.name, exact: true }).click();
  await expect(nav(page)).toBeHidden(); await expect(contents(page)).toBeVisible();
  await expect(contents(page).getByRole('button', { name: 'Back to workspace navigation' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('single-left.png') });
  await contents(page).getByRole('searchbox', { name: 'Search chats' }).fill('Retained');
  await contents(page).getByRole('link', { name: 'Retained parity conversation', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`folder=${folder.id}.*conversation=parity-chat`));
  await page.goBack(); await expect(page).toHaveURL(new RegExp(`folder=${folder.id}$`));
  await expect(contents(page).getByRole('searchbox', { name: 'Search chats' })).toHaveValue('Retained');
  await page.goForward(); await expect(page).toHaveURL(/conversation=parity-chat$/);
  await contents(page).getByRole('button', { name: 'Move sidebar right' }).click();
  expect(await x(contents(page))).toBeGreaterThan(await x(page.locator('#main')));
  await contents(page).getByRole('button', { name: 'Back to workspace navigation' }).click();
  await expect(nav(page)).toBeVisible(); await expect(contents(page)).toBeHidden();
  await nav(page).getByRole('link', { name: 'Calendar', exact: true }).click();
  await nav(page).getByRole('link', { name: folder.name, exact: true }).click();
  await expect(contents(page).getByRole('searchbox', { name: 'Search chats' })).toHaveValue('Retained');
  await expect(page).toHaveURL(new RegExp(`folder=${folder.id}.*conversation=parity-chat`));
  await chooseLayout(page, 'Adaptive Sidebar', 'right');
  await expect(contents(page).getByRole('searchbox', { name: 'Search chats' })).toHaveValue('Retained');
  await expect(nav(page)).toBeVisible(); await expect(contents(page)).toBeVisible();
  expect(await x(contents(page))).toBeLessThan(await x(nav(page)));
  expect(await x(contents(page))).toBeGreaterThan(await x(page.locator('#main')));
  await chooseLayout(page, 'Split Sidebar');
  await expect(contents(page).getByRole('searchbox', { name: 'Search chats' })).toHaveValue('Retained');
  expect(await x(nav(page))).toBeLessThan(await x(page.locator('#main')));
  expect(await x(contents(page))).toBeGreaterThan(await x(page.locator('#main')));
  await chooseLayout(page, 'Single Sidebar', 'right');
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style', 'single');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-side', 'right');
  await expect(nav(page)).toBeHidden(); await expect(contents(page)).toBeVisible();
  await expect(page.locator('#main').getByRole('heading', { name: 'Complete retained response', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('single-right.png') });
  assertClean(state);
});

test('adaptive opens adjacent contents only on selection, reorders stable nodes, and back preserves search', async ({ page, baseURL }, testInfo) => {
  await page.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
  const state = await setup(page, baseURL, prefs('adaptive'));
  await page.goto(root);
  await expect(nav(page)).toBeVisible(); await expect(contents(page)).toBeHidden();
  await expect(nav(page).getByRole('searchbox')).toHaveCount(0);
  await nav(page).getByRole('link', { name: folder.name, exact: true }).click();
  await expect(contents(page)).toBeVisible();
  expect(await x(nav(page))).toBeLessThan(await x(contents(page)));
  expect(await x(contents(page))).toBeLessThan(await x(page.locator('#main')));
  await page.screenshot({ path: testInfo.outputPath('adaptive-left.png') });
  await expect(contents(page).getByRole('link', { name: 'New chat', exact: true })).toHaveCount(0);
  await contents(page).getByRole('searchbox', { name: 'Search chats' }).fill('Retained');
  await contents(page).evaluate(node => { window.originalContentRail = node; });
  await nav(page).getByRole('button', { name: 'Move sidebar right' }).click();
  expect(await contents(page).evaluate(node => node === window.originalContentRail)).toBe(true);
  expect(await x(contents(page))).toBeLessThan(await x(nav(page)));
  expect(await x(contents(page))).toBeGreaterThan(await x(page.locator('#main')));
  await contents(page).getByRole('button', { name: 'Back to workspace navigation' }).click();
  await expect(contents(page)).toBeHidden();
  await page.clock.pauseAt(new Date('2026-10-23T12:01:00Z'));
  await nav(page).getByRole('link', { name: 'All Workspaces', exact: true }).click();
  await expect(contents(page).getByRole('searchbox', { name: 'Search chats' })).toHaveValue('Retained');
  await contents(page).getByRole('tab', { name: 'Chats', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  // Release the pending navigation callback only after an intentional focus
  // move; it must not take focus back from the selected Notes tab.
  await expect(contents(page).getByRole('tab', { name: 'Notes', exact: true })).toBeFocused();
  await page.clock.runFor(32);
  await expect(contents(page).getByRole('tab', { name: 'Notes', exact: true })).toBeFocused();
  await expect(contents(page).getByRole('searchbox', { name: 'Search notes' })).toHaveValue('Retained');
  await page.screenshot({ path: testInfo.outputPath('adaptive-right.png') });
  assertClean(state);
});

for (const fallback of [false, true]) test(`deferred folder focus hands off from ${fallback ? 'body fallback' : 'its initiating control'}`, async ({ page, baseURL }) => {
  await page.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
  const state = await setup(page, baseURL, prefs('adaptive'));
  await page.goto(root);
  const trigger = nav(page).getByRole('link', { name: folder.name, exact: true });
  await expect(trigger).toBeVisible();
  await page.clock.pauseAt(new Date('2026-10-23T12:01:00Z'));
  await trigger.click();
  await expect(trigger).toBeFocused();
  if (fallback) {
    await trigger.evaluate(node => node.blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  }
  await page.clock.runFor(32);
  await expect(contents(page).getByRole('button', { name: 'Back to workspace navigation' })).toBeFocused();
  assertClean(state);
});

test('device-local preferences isolate users, reject malformed storage and never save profile', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  await page.goto(workspace);
  await chooseLayout(page, 'Single Sidebar', 'right');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).toMatchObject({ version: 1, style: 'single', side: 'right' });
  await page.route('**/api/session', route => route.fulfill({ json: { user: { ...user, id: 'another-member', role: 'member' }, csrfToken: null } }));
  await page.route('**/api/organizations', route => route.fulfill({ json: { items: [{ ...org, role: 'member', libraryAccess: 'read' }] } }));
  await page.reload(); await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style', 'adaptive');
  await page.goto(`${base}/workspaces`);
  await expect(nav(page).getByRole('link', { name: 'Members', exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('wme:sidebar:v1:another-member', '{invalid'));
  await page.goto(workspace); await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style', 'adaptive');
  assertClean(state);
});

for (const style of ['split', 'single', 'adaptive']) {
  test(`${style} compact drawers stay below the header, contain focus and restore it`, async ({ page, baseURL }, testInfo) => {
    const state = await setup(page, baseURL, prefs(style, style === 'split' ? 'left' : 'right'));
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(root);
    const opener = page.getByRole('button', { name: 'Show navigation sidebar', exact: true });
    await opener.focus(); await page.keyboard.press('Enter');
    let drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(drawer).toBeVisible();
    const header = await page.locator('.platform-header').boundingBox();
    expect((await drawer.boundingBox()).y).toBeGreaterThanOrEqual(header.y + header.height);
    const close = drawer.getByRole('button', { name: 'Hide navigation sidebar', exact: true });
    await expect(close).toBeFocused(); await page.keyboard.press('Shift+Tab');
    expect(await drawer.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab'); await expect(close).toBeFocused();
    await nav(page).getByRole('link', { name: folder.name, exact: true }).click();
    if (style === 'split') {
      await expect(drawer).toHaveCount(0);
      await page.getByRole('button', { name: 'Show workspace sidebar' }).click();
    }
    drawer = page.getByRole('dialog', { name: 'Workspace sidebar', exact: true });
    await expect(drawer).toBeVisible(); await expect(contents(page)).toBeVisible();
    await contents(page).getByRole('searchbox', { name: 'Search chats' }).fill('Retained');
    await page.screenshot({ path: testInfo.outputPath(`${style}-mobile.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(contents(page).getByRole('searchbox', { name: 'Search chats' })).toHaveValue('');
    await expect(drawer).toBeVisible();
    await contents(page).getByRole('searchbox', { name: 'Search chats' }).fill('Retained');
    await contents(page).getByRole('tab', { name: 'Chats', exact: true }).focus();
    await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('button', { name: style === 'split' ? 'Show workspace sidebar' : 'Show navigation sidebar', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 855, height: 900 });
    await expect(page.locator('.sidebar-backdrop')).toHaveCount(0);
    if (style === 'split') {
      await expect(nav(page)).toBeVisible();
      await page.getByRole('button', { name: 'Show workspace sidebar' }).click();
      await expect(contents(page)).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${style}-intermediate-855.png`) });
    await page.setViewportSize({ width: 1536, height: 1024 });
    await expect(contents(page).getByRole('searchbox', { name: 'Search chats' })).toHaveValue('Retained');
    assertClean(state);
  });
}

test('folder-scoped new chat and both new-note actions preserve the open conversation', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, prefs('single'));
  const records = [], writes = [];
  await page.route('**/projects/parity-project/workspace-content**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); writes.push(body);
      const record = { ...body, id: `sidebar-note-${records.length + 1}`, projectId: project.id, revision: 1, createdBy: user.id, updatedBy: user.id, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' };
      records.push(record); return route.fulfill({ json: record });
    }
    return route.fulfill({ json: records.find(record => path.endsWith(`/${record.id}`)) ?? { items: records } });
  });
  await page.goto(`${root}?folder=${folder.id}&agent=codex&conversation=parity-chat`);
  await contents(page).getByRole('link', { name: 'New chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Folder', exact: true })).toHaveValue(folder.id);
  await expect(dialog.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('codex');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(contents(page).getByRole('link', { name: 'New chat', exact: true })).toBeFocused();
  await expect(page).toHaveURL(/conversation=parity-chat/);
  await contents(page).getByRole('button', { name: 'New note', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Open note' })).toBeVisible();
  await expect(page).toHaveURL(/conversation=parity-chat.*note=sidebar-note-1/);
  await expect(contents(page).getByRole('tab', { name: 'Notes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(contents(page).getByRole('link', { name: 'Untitled note', exact: true })).toBeVisible();
  await contents(page).getByRole('button', { name: 'Back to workspace navigation' }).click();
  await nav(page).getByRole('button', { name: 'Create note or artifact', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New note', exact: true }).click();
  await expect(page).toHaveURL(/conversation=parity-chat.*note=sidebar-note-2/);
  expect(writes).toEqual(Array.from({ length: 2 }, () => ({ kind: 'note', title: 'Untitled note', body: '', folderId: folder.id, data: { format: 'markdown' } })));
  assertClean(state);
});

test('unavailable browser storage keeps the session usable and discloses non-persistence', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Synthetic blocked browser storage', 'SecurityError'); }; });
  await page.goto(workspace);
  await page.locator(".platform-header").getByRole('link', { name: "Settings", exact: true }).click();
  await page.getByRole('radio', { name: /^Single Sidebar/ }).check();
  await expect(page.getByRole('alert')).toContainText('Browser storage is unavailable');
  await page.getByRole('link', { name: 'Back to organization', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style', 'single');
  assertClean(state);
});

test('sidebar preferences follow the account across organizations and workspaces', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  const secondOrg = { ...org, id: 'second-org', name: 'Second synthetic organization' };
  const secondProject = { ...project, id: 'second-project', orgId: secondOrg.id, name: 'Second synthetic workspace' };
  await page.route('**/api/organizations', route => route.fulfill({ json: { items: [org, secondOrg] } }));
  await page.route('**/organizations/second-org/projects', route => route.fulfill({ json: { items: [secondProject] } }));
  await page.route('**/api/projects/second-project', route => route.fulfill({ json: secondProject }));
  await page.goto(root); await chooseLayout(page, 'Single Sidebar', 'right');
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await page.locator('main').getByRole('link', { name: 'Organizations', exact: true }).click();
  await page.locator('a[href="/enterprise/organizations/second-org/workspaces"]').click();
  await page.getByRole('link', { name: secondProject.name, exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style', 'single');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-side', 'right');
  expect(await x(nav(page))).toBeGreaterThan(await x(page.locator('#main')));
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style', 'single');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-side', 'right');
  assertClean(state);
});

for (const side of ['left', 'right']) {
  test(`adaptive ${side} intermediate layouts keep conversation, Calendar and Databases contained`, async ({ page, baseURL }, testInfo) => {
    const state = await setup(page, baseURL, prefs('adaptive', side));
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const database = { id: 'sidebar-database', name: 'Long synthetic database name with retained structured workspace data', revision: 1, updatedAt: '2026-10-23T00:00:00Z' };
    const longCell = 'Synthetic database result '.repeat(24);
    await page.route('**/projects/parity-project/databases', route => {
      const body = route.request().postDataJSON();
      expect(['list', 'query']).toContain(body.action);
      return route.fulfill({ json: body.action === 'query' ? { query: { contractVersion: 1, columns: ['Long retained result column'], rows: [[longCell]] } } : { databases: [database] } });
    });
    for (const width of [855, 900, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['', '/calendar', '/databases']) {
        await page.goto(`${root}${route}?folder=${folder.id}&conversation=parity-chat`);
        await expect(contents(page)).toBeVisible();
        await expect(page.locator('.sidebar-backdrop')).toHaveCount(0);
        expect(await page.locator('#main').evaluate(n=>!n.inert)).toBe(true);
        const main = page.locator('#main');
        if (route) await expect(main.getByRole('heading', { name: route === '/calendar' ? 'Calendar' : 'Databases', exact: true })).toBeVisible();
        else await expect(page.getByLabel('Message your agent')).toBeVisible();
        if (route === '/databases') { await main.getByRole('button', { name: 'Run query', exact: true }).click(); await expect(main.getByRole('cell', { name: longCell.trim(), exact: true })).toBeVisible(); }
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await main.boundingBox()).width).toBeGreaterThanOrEqual(360);
        expect(await main.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`adaptive-${side}-${width}-${route.slice(1) || 'conversation'}.png`) });
      }
    }
    expect(errors).toEqual([]); assertClean(state);
  });
}

for (const side of ['left', 'right']) {
  test(`adaptive ${side} open note fits intermediate center and closes back to a usable conversation`, async ({ page, baseURL }, testInfo) => {
    const state = await setup(page, baseURL, prefs('adaptive', side));
    const note = { id: 'sidebar-view-note', projectId: project.id, kind: 'note', title: 'Long retained synthetic note', body: 'Synthetic note body', folderId: folder.id, data: { format: 'markdown' }, revision: 1, createdBy: user.id, updatedBy: user.id, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' };
    await page.route('**/projects/parity-project/workspace-content/sidebar-view-note', route => route.fulfill({ json: note }));
    for (const width of [855, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${root}?folder=${folder.id}&conversation=parity-chat&note=${note.id}`);
      const panel = page.getByRole('region', { name: 'Open note', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue(note.title);
      const area = await page.locator('#main').boundingBox(), bounds = await panel.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(area.x); expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width);
      expect(bounds.width).toBeGreaterThanOrEqual(300);
      expect(await page.locator('#main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`adaptive-${side}-${width}-note.png`) });
      await page.getByRole('button', { name: 'Close note', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByLabel('Message your agent')).toBeVisible();
      expect((await page.getByLabel('Message your agent').boundingBox()).width).toBeGreaterThan(250);
      await expect(page).toHaveURL(/conversation=parity-chat$/);
    }
    assertClean(state);
  });
}

test('Single folder plus returns cancelled chooser focus to the visible content action', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, prefs('single'));
  await page.goto(root);
  const plus = nav(page).getByRole('link', { name: `New chat in ${folder.name}`, exact: true });
  await plus.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Folder', exact: true })).toHaveValue(folder.id);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(nav(page)).toBeHidden(); await expect(contents(page)).toBeVisible();
  await expect(contents(page).getByRole('link', { name: 'New chat', exact: true })).toBeFocused();
  assertClean(state);
});

test('Adaptive phone folder overlay restores focus to the same toggle', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, prefs('adaptive'));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(root);
  const opener = page.getByRole('button', { name: 'Show navigation sidebar' });
  await opener.click();
  const link = nav(page).getByRole('link', { name: folder.name, exact: true });
  await link.focus(); await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Workspace sidebar', exact: true });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
  assertClean(state);
});
