import { test as baseTest, expect } from '@playwright/test';
import { parityFixture, connectionResources, workspace, base, folder, markdown } from './ui-parity.fixture.mjs';

// Fixture setup failures must fail even when the visible UI assertion passes.
const test = baseTest.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(page);
    expect(errors, 'uncaught document/fixture errors').toEqual([]);
  },
});
test.use({ storageState: { cookies: [], origins: [] } });
const picker = (page, label) => page.getByRole('button', { name: new RegExp(`^${label}`) });

test('menus and pickers focus visible choices, navigate, dismiss', async ({ page, baseURL }) => {
  const state = await parityFixture(page, { baseURL });
  await page.goto(workspace);
  const menu = page.getByRole('button', { name: `Actions for folder ${folder.name}`, exact: true });
  await menu.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End'); await expect(page.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(menu).toBeFocused();
  const model = picker(page, 'Conversation model');
  await model.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { selected: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('option', { name: 'Other synthetic model' })).toBeFocused();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Tab'); await expect(page.getByRole('listbox')).toHaveCount(0); await expect(model).toBeFocused();
  await model.click(); await menu.click();
  await expect(page.getByRole('listbox')).toHaveCount(0); await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('heading', { name: 'Retained parity conversation' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
});

test('open pickers become inert when canonical work disables controls; empty popouts dismiss by keyboard', async ({ page, baseURL }) => {
  const state = await parityFixture(page, { baseURL });
  await page.goto(workspace);
  const model = picker(page, 'Conversation model');
  await model.click(); await expect(page.getByRole('listbox')).toBeVisible();
  state.disabled = true; await state.refresh('run.started');
  await expect(model).toBeDisabled(); await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  expect(state.writes).toEqual([]);
  // New document with no model options: popup itself takes focus for Escape.
  await page.context().unrouteAll();
  await parityFixture(page, { baseURL, emptyModels: true }); await page.goto(workspace);
  await picker(page, 'Conversation model').focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('No models are available.', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('No models are available.', { exact: false })).toHaveCount(0);
  await expect(picker(page, 'Conversation model')).toBeFocused();
  // Exercise the new clipboard stub after both persisted init scripts run.
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => window.clipboardWrites)).toEqual(['const revision = 1;']);
});

for (const change of ['disable', 'remove']) {
  test(`canonical ${change} of the focused menu action preserves arrows and Escape`, async ({ page, baseURL }) => {
    const state = await parityFixture(page, { baseURL });
    await page.goto(workspace);
    const trigger = page.getByRole('button', { name: 'Conversation actions', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const settings = page.getByRole('menuitem', { name: 'Conversation settings', exact: true });
    await settings.focus(); await expect(settings).toBeFocused();
    if (change === 'disable') state.disabled = true;
    else state.createdBy = 'another-authorized-member';
    await state.refresh(change === 'disable' ? 'run.started' : 'settings.changed');
    if (change === 'disable') await expect(settings).toBeDisabled();
    else await expect(settings).toHaveCount(0);
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem').filter({ hasText: change === 'disable' ? 'Move to Trash' : 'Stop background work' })).toBeFocused();
    if (change === 'disable') {
      await settings.evaluate(node => node.click());
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.keyboard.press('ArrowUp');
      await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toBeFocused();
    }
    await page.keyboard.press('Home'); await expect(page.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitem').nth(1)).toBeFocused();
    await page.keyboard.press('End'); await expect(page.getByRole('menuitem').last()).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
  });
}

test('menu focus recovers after canonical disablement inside an asset dialog; Escape closes only the popup', async ({ page, baseURL }) => {
  const state = await parityFixture(page, { baseURL });
  await page.goto(`${base}/library`);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: /Parity asset/ }).click();
  const dialog = page.getByRole('dialog');
  const trigger = dialog.getByRole('button', { name: 'Conversation actions', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const settings = page.getByRole('menuitem', { name: 'Conversation settings', exact: true });
  await settings.focus(); state.disabled = true; await state.refresh('run.started');
  await expect(settings).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toBeFocused();
  expect(await page.getByRole('menu').evaluate(node => node.matches(':popover-open'))).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(dialog).toBeVisible(); await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
});

test('dynamic popup with no enabled actions keeps surface focus and keyboard dismissal', async ({ page, baseURL }) => {
  const state = await parityFixture(page, { baseURL });
  await page.goto(workspace);
  const trigger = page.getByRole('button', { name: 'Conversation actions', exact: true });
  await trigger.click();
  // Primitive boundary: the real conversation always retains export links.
  // Remove those links, then disable every remaining action in one DOM update.
  await page.getByRole('menu').evaluate(node => {
    node.querySelectorAll('a').forEach(link => link.remove());
    node.querySelectorAll('button').forEach(button => { button.disabled = true; });
  });
  await expect(page.getByRole('menu')).toBeFocused();
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Space']) await page.keyboard.press(key);
  await expect(page.getByRole('menu')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(state.writes).toEqual([]);
});

for (const theme of ['green', 'cognac', 'dark']) {
  test(`${theme}: Connections resources distinguish loading, unavailable, retry, empty and stale data`, async ({ page, baseURL }) => {
    const state = await parityFixture(page, { baseURL, theme });
    const resources = await connectionResources(page);
    const sections = {
      accounts: { title: 'Model providers', loading: 'connections', empty: 'No connections yet', present: 'Retained organization key' },
      models: { title: 'Available models', loading: 'models', empty: 'Models will appear when a connected provider makes them available.', present: 'Retained available model' },
      usage: { title: 'Observed usage', loading: 'usage', empty: 'No request usage recorded.', present: 'OpenRouter' },
    };
    await page.goto(`${base}/settings/connections`);
    for (const [name, config] of Object.entries(sections)) {
      const section = page.getByRole('region', { name: config.title, exact: true });
      await expect(section.getByRole('status')).toHaveText(`Loading ${config.loading}…`);
      await expect(section.getByText(config.empty, { exact: true })).toHaveCount(0);
      resources[name].reply('error');
      await expect(section.getByRole('alert')).toContainText(`Synthetic ${name} unavailable`);
      await expect(section.getByText(config.empty, { exact: true })).toHaveCount(0);
    }
    for (const [name, config] of Object.entries(sections)) {
      const section = page.getByRole('region', { name: config.title, exact: true });
      const reads = Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, value.reads]));
      resources[name].mode = 'loading';
      await section.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(section.getByRole('status')).toHaveText(`Loading ${config.loading}…`);
      resources[name].reply('empty');
      await expect(section.getByText(config.empty, { exact: true })).toBeVisible();
      await expect(section.getByRole('alert')).toHaveCount(0);
      expect(resources[name].reads).toBe(reads[name] + 1);
      for (const other of Object.keys(resources).filter(key => key !== name)) expect(resources[other].reads).toBe(reads[other]);
    }
    for (const entry of Object.values(resources)) entry.mode = 'present';
    await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
    for (const config of Object.values(sections)) {
      const section = page.getByRole('region', { name: config.title, exact: true });
      await expect(section.getByText(config.present, { exact: true })).toBeVisible();
      await expect(section.getByText(config.empty, { exact: true })).toHaveCount(0);
    }
    await expect(page.getByText('Priority 7', { exact: true })).toBeVisible();
    await expect(page.getByText('disabled', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '23', exact: true })).toBeVisible();
    for (const entry of Object.values(resources)) entry.mode = 'loading';
    await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
    for (const [name, config] of Object.entries(sections)) {
      const section = page.getByRole('region', { name: config.title, exact: true });
      await expect(section.getByRole('status').filter({ hasText: 'Refreshing' })).toHaveText(`Refreshing ${config.loading}…`);
      await expect(section.getByText(config.present, { exact: true })).toBeVisible();
      resources[name].reply('error');
      await expect(section.getByRole('alert')).toContainText(`Synthetic ${name} unavailable`);
      await expect(section.getByText(config.present, { exact: true })).toBeVisible();
      await expect(section.getByText(config.empty, { exact: true })).toHaveCount(0);
      resources[name].mode = 'present';
      await section.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(section.getByRole('alert')).toHaveCount(0);
      await expect(section.getByText(config.present, { exact: true })).toBeVisible();
    }
    // Retention must never override an authorization failure.
    for (const entry of Object.values(resources)) entry.mode = 'forbidden';
    await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
    for (const config of Object.values(sections)) {
      const section = page.getByRole('region', { name: config.title, exact: true });
      await expect(section.getByRole('alert')).toBeVisible();
      await expect(section.getByText(config.present, { exact: true })).toHaveCount(0);
      await expect(section.getByText(config.empty, { exact: true })).toHaveCount(0);
    }
    expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
  });
}

test('expanded Markdown survives same-route popstate and background canonical content refresh', async ({ page, baseURL }) => {
  const state = await parityFixture(page, { baseURL });
  await page.goto(workspace);
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Table', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => { history.replaceState(history.state, '', location.href + '&harmless-query=1'); dispatchEvent(new PopStateEvent('popstate', { state: history.state })); });
  await expect(dialog).toBeVisible();
  state.revision = 2; await state.refresh();
  await expect(dialog.getByRole('cell', { name: '2', exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.code-block pre')).toHaveText('const revision = 2;\n');
  await expect(page.getByRole('link', { name: 'Protected source' })).toHaveAttribute('href', `${base}/source/parity-file`);
  await expect(page.getByRole('link', { name: 'Unsafe', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.unsafeMarkdown)).toBeUndefined();
  await expect(page.locator('.markdown img')).toHaveCount(0);
  const popup = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Protected source' }).click();
  const source = await popup;
  await expect(source.locator('.text-preview')).toHaveText('Complete synthetic protected source.');
  await source.close();
  const citation = page.getByRole('link', { name: 'Retained citation · page 2', exact: true });
  await expect(citation).toHaveAttribute('href', `${base}/source/parity-file?projectId=parity-project&versionId=parity-version&page=2`);
  const citationPopup = page.waitForEvent('popup'); await citation.click();
  const citationPage = await citationPopup; await expect(citationPage.locator('.text-preview')).toHaveText('Complete synthetic protected source.');
  expect(new URL(citationPage.url()).searchParams.get('versionId')).toBe('parity-version');
  expect(new URL(citationPage.url()).searchParams.get('page')).toBe('2');
  await citationPage.close();
  expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
});

for (const kind of ['code', 'table', 'response']) {
  test(`copy ${kind} feedback follows the exact content and ignores stale clipboard completion`, async ({ page, baseURL }) => {
    const state = await parityFixture(page, { baseURL });
    await page.goto(workspace);
    const button = page.getByRole('button', { name: `Copy ${kind}`, exact: true });
    const status = kind === 'response' ? page.locator('.response-actions [role="status"]') : button;
    await button.click(); await expect(status).toContainText('Copied');
    const expected = kind === 'code' ? 'const revision = 1;' : kind === 'table' ? 'Item\tRevision\nRecord\t1' : markdown(1);
    expect(await page.evaluate(() => window.clipboardWrites.at(-1))).toBe(expected);
    state.revision = 2; await state.refresh();
    await expect(page.getByText('Revision 2', { exact: true })).toBeVisible();
    await expect(status).not.toContainText('Copied');
    await page.evaluate(() => { window.holdClipboard = true; }); await button.click();
    await expect(status).toContainText('Copying');
    state.revision = 3; await state.refresh();
    await expect(page.getByText('Revision 3', { exact: true })).toBeVisible();
    await page.evaluate(() => { window.pendingClipboard.shift().resolve(); });
    await expect(status).not.toContainText('Copied');
    // A newer successful copy also wins over an older rejected completion.
    await button.click(); await button.click();
    await page.evaluate(() => { window.pendingClipboard.pop().resolve(); });
    await expect(status).toContainText('Copied');
    await page.evaluate(() => { window.pendingClipboard.shift().reject(new Error('Older clipboard failure')); });
    await expect(status).toContainText('Copied');
  });
}

for (const theme of ['green', 'cognac', 'dark']) {
  test(`${theme}: native folder/action geometry, provider hierarchy and composer arrangement`, async ({ page, baseURL }) => {
    const state = await parityFixture(page, { baseURL, theme });
    await page.goto(workspace);
    const plus = page.getByRole('link', { name: `New chat in ${folder.name}`, exact: true });
    const metrics = await plus.evaluate((node) => {
      const box = node.getBoundingClientRect(), icon = node.querySelector('svg'), css = getComputedStyle(node);
      return { width: box.width, height: box.height, radius: css.borderRadius, icon: icon.getBoundingClientRect().width, stroke: icon.getAttribute('stroke-width'), next: node.nextElementSibling };
    });
    expect(metrics).toMatchObject({ width: 24, height: 28, radius: '8px', icon: 12, stroke: '1.5', next: null });
    const composerFolder = await picker(page, 'Conversation folder').boundingBox();
    const editor = await page.getByLabel('Message your agent').boundingBox();
    const model = await picker(page, 'Conversation model').boundingBox();
    expect(composerFolder.y + composerFolder.height).toBeLessThanOrEqual(editor.y);
    expect(model.y).toBeGreaterThanOrEqual(editor.y + editor.height);
    const folderLink = page.getByRole('link', { name: folder.name, exact: true });
    await folderLink.hover();
    const hover = page.getByRole('tooltip');
    await expect(hover).toBeVisible();
    await expect(hover).toContainText('Parity workspace');
    await expect(hover).toContainText('1 conversation');
    await expect(hover).toContainText(folder.rootPath);
    await expect(hover).toContainText('Reference inputs');
    await plus.click(); await expect(page.getByRole('dialog', { name: 'New conversation' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveValue(folder.id);
    await page.keyboard.press('Escape');
    await page.goto(`${base}/settings/connections`);
    const router = page.locator('details').filter({ has: page.locator('summary', { hasText: /^OpenRouter$/ }) });
    const openai = page.locator('details').filter({ has: page.locator('summary', { hasText: /^OpenAI \/ ChatGPT$/ }) });
    await expect(router.locator('summary')).toHaveText(['OpenRouter']);
    await expect(openai.locator('summary')).toHaveText(['OpenAI / ChatGPT', 'Subscriptions', 'API keys']);
    await expect(router.getByText('Priority 1', { exact: true })).toBeVisible();
    await expect(router.getByText('disabled', { exact: true })).toBeVisible();
    const left = async (node) => (await node.boundingBox()).x;
    expect(await left(router.locator('.connection-row'))).toBe(await left(openai.locator('.connection-row').first()));
    for (const name of ['Manage OpenRouter fixture', 'Remove OpenRouter fixture']) {
      const geometry = await page.getByRole('button', { name, exact: true }).evaluate((node) => { const s = getComputedStyle(node); return { height: node.getBoundingClientRect().height, radius: s.borderRadius, left: s.paddingLeft, right: s.paddingRight }; });
      expect(geometry).toEqual({ height: 36, radius: '10px', left: '12px', right: '12px' });
    }
    await router.locator('summary').click(); await expect(router.getByText('OpenRouter fixture', { exact: true })).toBeHidden();
    await router.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(router.getByText('OpenRouter fixture', { exact: true })).toBeVisible();
    expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
  });
}


test('long model identifiers remain readable and keyboard scrolling reaches the last choice', async ({ page, baseURL }) => {
  const state = await parityFixture(page, { baseURL });
  const longName = 'UnbrokenModelIdentifier' + 'x'.repeat(100);
  state.models.push({ id: 'unbroken', name: longName, provider: 'custom', thinkingLevels: [] });
  for (let index = 0; index < 40; index++) state.models.push({ id: `long-${index}`, name: `Long model ${index} with full version and provider attribution`, provider: 'custom', thinkingLevels: [] });
  for (const viewport of [{ width: 1536, height: 1024 }, { width: 855, height: 769 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.goto(workspace);
    await picker(page, 'Conversation model').focus(); await page.keyboard.press('Enter');
    const option = page.getByRole('option', { name: longName, exact: true });
    await expect(option).toHaveText(longName);
    expect(await option.locator('.picker-option-text').evaluate(node => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().height <= node.parentElement.getBoundingClientRect().height)).toBe(true);
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await expect(option).toBeFocused(); await expect(option).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('End');
    const last = page.getByRole('option').last();
    await expect(last).toBeFocused(); await expect(last).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(page.getByRole('listbox')).toHaveCount(0);
  }
  expect(state.writes).toEqual([]); expect(state.external).toEqual([]);
});

test('coarse-pointer actions retain 44-point targets and Markdown utility strips contain them', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const state = await parityFixture(page, { baseURL }); await page.goto(workspace);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    for (const selector of ['.code-block-header', '.markdown-table-footer']) {
      const geometry = await page.locator(selector).evaluate(node => {
        const strip = node.getBoundingClientRect();
        return [...node.querySelectorAll('button')].map(button => { const b = button.getBoundingClientRect(); return { height: b.height, width: b.width, contained: b.top >= strip.top && b.bottom <= strip.bottom }; });
      });
      for (const item of geometry) { expect(item.height).toBeGreaterThanOrEqual(44); expect(item.width).toBeGreaterThanOrEqual(44); expect(item.contained).toBe(true); }
    }
    await page.getByRole('button', { name: 'Open navigation', exact: true }).tap();
    const plus = page.getByRole('link', { name: `New chat in ${folder.name}`, exact: true });
    const box = await plus.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    await plus.tap(); await expect(page.getByRole('dialog', { name: 'New conversation', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveValue(folder.id);
    expect(state.writes).toEqual([]); expect(state.external).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});


test('narrow navigation opens from the left and preserves keyboard return across breakpoints', async ({ page, baseURL }, testInfo) => {
  const state = await parityFixture(page, { baseURL });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/projects`);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  const sidebar = page.locator('.sidebar');
  for (const width of [390, 760]) {
    await page.setViewportSize({ width, height: 844 });
    const box = await menu.boundingBox();
    const title = await page.locator('.mobile-title').boundingBox();
    expect(box.x).toBeLessThan(16);
    expect(box.x + box.width).toBeLessThan(title.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(sidebar).toBeHidden();
    await menu.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible();
    expect((await sidebar.boundingBox()).x).toBeLessThan(16);
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden(); await expect(menu).toBeFocused();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('sidebar-mobile-left.png') });
  await menu.click();
  await sidebar.getByRole('link', { name: 'Parity workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/parity-project$/);
  await expect(sidebar).toBeHidden(); await expect(menu).toBeFocused();
  await page.setViewportSize({ width: 761, height: 844 });
  await expect(menu).toBeHidden(); await expect(sidebar).toBeVisible();
  await expect(page.locator('.sidebar-backdrop')).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
});

for (const initial of ['empty', 'no-match', 'populated']) {
  test(`sidebar ${initial} state stays still during polling and selection, then respects authorization loss`, async ({ page, baseURL }, testInfo) => {
    await page.clock.install();
    const state = await parityFixture(page, { baseURL });
    const chat = { id: 'parity-chat', title: 'Retained parity conversation', mode: 'write', effectiveMode: 'write', harness: 'pi', pi: {}, createdBy: 'parity-owner', folderId: folder.id, model: 'parity-model' };
    let items = initial === 'empty' ? [] : [chat], hold = false, status = 200;
    const pending = [];
    await page.route('**/projects/parity-project/conversations', async route => {
      if (hold) await new Promise(resolve => pending.push(resolve));
      await route.fulfill(status === 200
        ? { json: { items } }
        : { status, json: { error: { message: `Synthetic chat refresh ${status}` } } });
    });
    try {
      await page.goto(`${base}/projects/parity-project/settings`);
      const rail = page.locator('.workspace-navigation');
      const tools = page.getByRole('navigation', { name: 'Project navigation', exact: true });
      const chatLink = rail.getByRole('link', { name: chat.title, exact: true });
      const label = page.getByText(initial === 'no-match' ? 'No matching conversations.' : 'No conversations yet.', { exact: true });
      if (initial === 'no-match') await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill('absent conversation');
      if (initial === 'populated') await expect(chatLink).toBeVisible();
      else await expect(label).toBeVisible();
      const agents = rail.locator('details').filter({ has: page.locator(':scope > summary', { hasText: /^Agents$/ }) });
      await agents.locator(':scope > summary').click(); await expect(agents).not.toHaveAttribute('open', '');
      const before = await tools.boundingBox();
      await rail.evaluate(node => { window.retainedRail = node; });
      hold = true;
      await page.clock.fastForward(10000);
      await expect.poll(() => pending.length).toBe(1);
      if (initial === 'populated') await expect(chatLink).toBeVisible();
      else await expect(label).toBeVisible();
      for (const name of ['Files', 'Members', 'Project settings']) {
        await tools.getByRole('link', { name, exact: true }).click();
        await expect(tools.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
        expect((await tools.boundingBox()).y).toBe(before.y);
        expect(await rail.evaluate(node => node === window.retainedRail)).toBe(true);
        await expect(agents).not.toHaveAttribute('open', '');
      }
      if (initial === 'empty') await page.screenshot({ path: testInfo.outputPath('sidebar-refresh-stable.png') });
      const refreshed = page.waitForResponse(r => r.url().endsWith('/projects/parity-project/conversations') && r.status() === 200);
      hold = false; pending.splice(0).forEach(resolve => resolve()); await refreshed;
      // A retryable error keeps authorized data; access denial must clear it.
      status = 503;
      const failed = page.waitForResponse(r => r.url().endsWith('/projects/parity-project/conversations') && r.status() === 503);
      await page.evaluate(() => dispatchEvent(new Event('workspace-changed'))); await failed;
      await expect(rail.getByRole('alert')).toContainText('Synthetic chat refresh 503');
      if (initial === 'populated') await expect(chatLink).toBeVisible();
      else await expect(label).toBeVisible();
      expect((await tools.boundingBox()).y).toBeGreaterThan(before.y); // The explicit error notice occupies space.
      status = 403;
      const denied = page.waitForResponse(r => r.url().endsWith('/projects/parity-project/conversations') && r.status() === 403);
      await page.evaluate(() => dispatchEvent(new Event('workspace-changed'))); await denied;
      await expect(rail.getByRole('alert')).toContainText('Synthetic chat refresh 403');
      await expect(chatLink).toHaveCount(0); await expect(rail.locator('.rail-empty')).toHaveCount(0);
      status = 200; items = [];
      const restored = page.waitForResponse(r => r.url().endsWith('/projects/parity-project/conversations') && r.status() === 200);
      await page.evaluate(() => dispatchEvent(new Event('workspace-changed'))); await restored;
      await expect(rail.getByRole('alert')).toHaveCount(0);
      await expect(page.getByText(initial === 'no-match' ? 'No matching conversations.' : 'No conversations yet.', { exact: true })).toBeVisible();
      expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
    } finally { hold = false; pending.splice(0).forEach(resolve => resolve()); }
  });
}
