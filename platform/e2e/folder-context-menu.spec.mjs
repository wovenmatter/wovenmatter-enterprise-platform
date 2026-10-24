import { test as baseTest, expect } from '@playwright/test';
import { parityFixture, workspace, folder, project } from './ui-parity.fixture.mjs';

// Browser plugin not available; use the repository Playwright installation.
// Flow: workspace -> folder row right-click or keyboard context menu -> existing
// actions, bounded popup, dismissal and focus restoration without navigation.
const test = baseTest.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await use(page);
    expect(errors, 'document and console health').toEqual([]);
  },
});
test.use({ storageState: { cookies: [], origins: [] } });
const second = { ...folder, id: 'second-folder', name: 'Second synthetic folder', position: 1 };
const third = { ...folder, id: 'third-folder', name: 'Unpinned synthetic folder', pinned: false, position: 2 };
const link = (page, item = folder) => page.getByRole('link', { name: item.name, exact: true });
const menu = (page, item = folder) => page.getByRole('menu', { name: `Actions for folder ${item.name}`, exact: true });
const clean = state => { for (const key of ['external', 'unknown', 'writes']) expect(state[key], key).toEqual([]); };

async function setup(page, baseURL) {
  const state = await parityFixture(page, { baseURL });
  state.folders = [folder, second, third].map(item => ({ ...item }));
  await page.route('**/projects/parity-project/folders', route => route.fulfill({ json: { items: state.folders } }));
  await page.goto(workspace);
  await expect(page).toHaveURL(new URL(workspace, baseURL).href);
  await expect(page).toHaveTitle(/WovenMatter/);
  await expect(page.getByRole('heading', { name: 'Retained parity conversation' })).toBeVisible();
  await expect(link(page)).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  return state;
}

test('right-click opens the unchanged folder actions without a menu button or navigation', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL);
  const target = link(page), row = target.locator('..'), before = page.url();
  await expect(page.getByRole('button', { name: /^Actions for folder / })).toHaveCount(0);
  await expect(row.locator('button, .menu-trigger')).toHaveCount(0);
  await expect(row.getByRole('link', { name: `New chat in ${folder.name}`, exact: true })).toBeVisible();
  await target.hover(); await expect(page.getByRole('tooltip')).toBeVisible();
  const bounds = await target.boundingBox();
  await target.click({ button: 'right', position: { x: 25, y: 10 } });
  await expect(menu(page)).toBeVisible();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Unpin', 'Move up', 'Move down', 'Rename', 'Reference locations…', 'Remove folder…']);
  await expect(menu(page).getByRole('menuitem', { name: 'Move up', exact: true })).toBeDisabled();
  await expect(menu(page).getByRole('menuitem', { name: 'Move down', exact: true })).toBeEnabled();
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
  await expect(target).toHaveAttribute('aria-expanded', 'true');
  await expect(target).toHaveAttribute('aria-controls', await menu(page).getAttribute('id'));
  expect(await menu(page).evaluate(node => node.matches(':popover-open'))).toBe(true);
  let popup = await menu(page).boundingBox();
  expect(popup.x).toBeCloseTo(bounds.x + 25, 0);
  expect(popup.y).toBeCloseTo(bounds.y + 14, 0);
  await page.screenshot({ path: info.outputPath('folder-pointer-actions.png') });
  // Reopening the same menu uses the new pointer, including after it was open.
  await target.click({ button: 'right', position: { x: 50, y: 10 } });
  await expect(menu(page)).toBeVisible();
  popup = await menu(page).boundingBox(); expect(popup.x).toBeCloseTo(bounds.x + 50, 0);
  expect(page.url()).toBe(before);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0); await expect(target).toBeFocused();

  const model = page.getByRole('button', { name: /^Conversation model/ });
  await model.click(); await expect(page.getByRole('listbox')).toBeVisible();
  await target.click({ button: 'right' });
  await expect(page.getByRole('listbox')).toHaveCount(0); await expect(menu(page)).toBeVisible();
  await link(page, second).click({ button: 'right', position: { x: 8, y: 8 } });
  await expect(page.getByRole('menu')).toHaveCount(1); await expect(menu(page, second)).toBeVisible();
  await expect(menu(page, second).getByRole('menuitem', { name: 'Move up', exact: true })).toBeEnabled();
  await expect(menu(page, second).getByRole('menuitem', { name: 'Move down', exact: true })).toBeDisabled();
  await page.locator('.transcript').click({ position: { x: 80, y: 12 } });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await target.click({ button: 'right' }); await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
  await expect(menu(page)).toHaveCount(0); await expect(page.getByRole('menu', { name: 'Conversation actions', exact: true })).toBeVisible();
  expect(page.url()).toBe(before); clean(state);
});

test('ContextMenu and Shift+F10 preserve action navigation, dismissal and dialog focus', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL), target = link(page), before = page.url();
  for (const shortcut of ['ContextMenu', 'Shift+F10']) {
    await target.focus(); await page.keyboard.press(shortcut);
    await expect(menu(page).getByRole('menuitem', { name: 'Unpin', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem', { name: 'Move down', exact: true })).toBeFocused();
    await page.keyboard.press('End'); await expect(menu(page).getByRole('menuitem').last()).toBeFocused();
    await page.keyboard.press('Home'); await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press(shortcut === 'ContextMenu' ? 'Escape' : 'Tab');
    await expect(menu(page)).toHaveCount(0); await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('aria-expanded', 'false');
    expect(page.url()).toBe(before);
  }
  for (const [action, title] of [['Rename', 'Rename folder'], ['Reference locations…', 'Reference locations'], ['Remove folder…', 'Remove folder?']]) {
    await target.focus(); await page.keyboard.press('Shift+F10');
    await menu(page).getByRole('menuitem', { name: action, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible(); await expect(menu(page)).toHaveCount(0);
    if (action === 'Rename') await expect(dialog.getByRole('textbox', { name: 'Folder name' })).toHaveValue(folder.name);
    if (action === 'Reference locations…') await expect(dialog.getByRole('textbox')).toHaveValue(folder.referencePaths.join('\n'));
    if (action === 'Remove folder…') {
      await expect(dialog.getByText(folder.rootPath, { exact: true })).toBeVisible();
      await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(target).toBeFocused();
  }
  // Ordinary activation still selects a folder rather than opening its menu.
  await target.click({ button: 'right' }); await expect(menu(page)).toBeVisible();
  await target.press('Enter');
  await expect(page).toHaveURL(new URL(workspace.replace('folder=all', `folder=${folder.id}`), baseURL).href);
  await expect(menu(page)).toHaveCount(0); clean(state);
});

test('folder pin and ordering actions retain their authorized project endpoints', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL), writes = [];
  await page.route('**/projects/parity-project/folders/*', async route => {
    const request = route.request(), body = request.postDataJSON();
    writes.push({ path: new URL(request.url()).pathname, method: request.method(), body });
    const item = state.folders.find(item => item.id === new URL(request.url()).pathname.split('/').at(-1));
    if (body.direction) {
      const index = state.folders.indexOf(item), next = index + (body.direction === 'down' ? 1 : -1);
      [state.folders[index], state.folders[next]] = [state.folders[next], state.folders[index]];
    } else item.pinned = body.pinned;
    await route.fulfill({ json: item });
  });
  for (const [action, body] of [['Move down', { direction: 'down' }], ['Move up', { direction: 'up' }], ['Unpin', { pinned: false }], ['Pin', { pinned: true }]]) {
    await link(page).click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: action, exact: true }).click();
    await expect(menu(page)).toHaveCount(0);
    await expect.poll(() => writes.at(-1)).toEqual({ path: `/enterprise/api/projects/${project.id}/folders/${folder.id}`, method: 'PATCH', body });
    if (body.direction) await expect(page.locator('.workspace-navigation [data-folder-selection][aria-haspopup="menu"]')).toHaveText(body.direction === 'down' ? [second.name + '0', folder.name + '1', third.name + '0'] : [folder.name + '1', second.name + '0', third.name + '0']);
    else await expect(link(page)).toHaveAttribute('aria-description', new RegExp(body.pinned ? ', Pinned$' : 'Reference inputs$'));
  }
  expect(writes).toHaveLength(4); clean(state);
});

for (const viewport of [{ width: 1320, height: 769 }, { width: 390, height: 520 }]) {
  test(`right-edge folder popup stays in ${viewport.width}×${viewport.height} viewport`, async ({ page, baseURL }, info) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem('wme:sidebar:v1:parity-owner', JSON.stringify({ version: 1, style: 'single', side: 'right', navigationVisible: true, contentVisible: true, singleVisible: true })));
    const state = await parityFixture(page, { baseURL });
    await page.goto(workspace);
    if (viewport.width < 640) await page.getByRole('button', { name: 'Show navigation sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Back to workspace navigation', exact: true }).click();
    const target = link(page); await target.scrollIntoViewIfNeeded();
    const row = target.locator('..'), bounds = await row.boundingBox();
    await row.click({ button: 'right', position: { x: bounds.width - 2, y: bounds.height - 2 } });
    await expect(menu(page)).toBeVisible();
    await expect.poll(async () => {
      const box = await menu(page).boundingBox();
      return box.x >= 8 && box.y >= 8 && box.x + box.width <= viewport.width - 8 && box.y + box.height <= viewport.height - 8;
    }).toBe(true);
    await page.keyboard.press('End'); await expect(menu(page).getByRole('menuitem').last()).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`folder-edge-${viewport.width}.png`) });
    await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0); await expect(target).toBeFocused();
    if (viewport.width < 640) await expect(page.locator('.sidebar-backdrop')).toBeVisible();
    clean(state);
  });
}
