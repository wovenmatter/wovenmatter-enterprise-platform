import { test, expect } from '@playwright/test';
import { parityFixture, workspace, base, project, folder } from './ui-parity.fixture.mjs';

// Browser plugin unavailable: local Playwright with synthetic API fixtures only.
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: 'reduce' });
const form = page => page.locator('.composer-area > form');

async function setup(page, baseURL, { native = false, welcome = false } = {}) {
  const state = await parityFixture(page, { baseURL });
  state.errors = []; state.patches = [];
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.errors.push(message.text()); });
  state.native = { configured: {}, settings: { model: 'parity-model', thinking: 'high', permission: 'default', models: [], thinkingLevels: [{ id: 'high', label: 'High' }], permissions: [{ id: 'default', label: 'Native default' }, { id: 'acceptEdits', label: 'Accept edits' }], canConfigure: true }, interactions: [] };
  const chat = { id: 'parity-chat', title: 'Responsive native fixture', harness: 'codex', model: 'parity-model', mode: 'write', effectiveMode: 'write', folderId: folder.id, workspaceLocked: false, createdBy: 'parity-owner', pi: {}, lastEventId: 0 };
  if (native) {
    await page.route('**/api/conversations/parity-chat', route => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); state.patches.push(body);
        Object.assign(state.native.configured, body.native);
        if (body.model) chat.model = body.model;
      }
      return route.fulfill({ json: chat });
    });
    await page.route('**/api/conversations/parity-chat/native', route => route.fulfill({ json: state.native }));
  }
  await page.goto(welcome ? `${base}/workspaces/${project.id}?folder=${folder.id}` : workspace);
  await expect(page.getByLabel('Message your agent')).toBeVisible();
  await expect(form(page)).toHaveAttribute('data-composer-layout', /regular|compact/);
  return state;
}

async function oneRowWithinForm(page) {
  const geometry = await form(page).evaluate(node => {
    const box = node.getBoundingClientRect();
    const buttons = [...node.querySelectorAll('.composer-controls button')]
      .filter(button => button.getClientRects().length && !button.closest('[popover]'))
      .map(button => { const rect = button.getBoundingClientRect(); return { name: button.getAttribute('aria-label') || button.textContent, left: rect.left, right: rect.right, center: rect.top + rect.height / 2, width: rect.width, height: rect.height }; });
    return { left: box.left, right: box.right, buttons, overflow: node.scrollWidth > node.clientWidth };
  });
  expect(geometry.overflow).toBe(false);
  expect(geometry.buttons.length).toBeGreaterThan(3);
  for (const button of geometry.buttons) {
    expect(button.left, button.name).toBeGreaterThanOrEqual(geometry.left);
    expect(button.right, button.name).toBeLessThanOrEqual(geometry.right);
    expect(Math.abs(button.center - geometry.buttons[0].center), button.name).toBeLessThanOrEqual(1);
    expect(button.width, button.name).toBeGreaterThanOrEqual(36);
    expect(button.height, button.name).toBeGreaterThanOrEqual(36);
  }
}
const clean = state => { for (const key of ['errors', 'external', 'unknown', 'writes']) expect(state[key], key).toEqual([]); };

test('welcome controls fit one row at 855px and restore labels with room', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 855, height: 769 });
  const state = await setup(page, baseURL, { welcome: true });
  await expect(form(page)).toHaveAttribute('data-composer-layout', /regular|compact/);
  await oneRowWithinForm(page);
  await expect(form(page).getByRole('button', { name: /^Agent / })).toHaveCount(0);
  await expect(form(page).getByRole('button', { name: /^Thinking level / })).toBeVisible();
  await page.getByLabel('Message your agent').fill('Review the workspace material');
  await page.screenshot({ path: info.outputPath('composer-855.png') });
  const model = form(page).getByRole('button', { name: /^Model / });
  await model.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Model', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(model).toBeFocused();
  await page.getByRole('button', { name: 'Add files or photos', exact: true }).click();
  await page.screenshot({ path: info.outputPath('composer-attachments-855.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 769 });
  await expect(page.locator('.sidebar-layout')).toHaveClass(/adaptive-expanded/);
  await expect(form(page)).toHaveAttribute('data-composer-layout', /regular|compact/);
  await oneRowWithinForm(page);
  await page.screenshot({ path: info.outputPath('composer-1280.png') });
  await page.setViewportSize({ width: 1536, height: 769 });
  await expect(form(page)).toHaveAttribute('data-composer-layout', 'regular');
  await oneRowWithinForm(page);
  await expect(model).toContainText('Synthetic selected model');
  await page.screenshot({ path: info.outputPath('composer-1536.png') });
  clean(state);
});

test('native compact model thinking permission and message menus keep accessible choices at 855px', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 855, height: 769 });
  const state = await setup(page, baseURL, { native: true });
  await expect(form(page)).toHaveAttribute('data-composer-layout', 'compact');
  await expect(form(page).getByRole('button', { name: /^Native permissions Native default/ })).toBeVisible();
  await oneRowWithinForm(page);
  const permission = form(page).getByRole('button', { name: /^Native permissions/ });
  await expect(permission).toHaveCSS('width', '36px');
  await permission.click();
  await expect(page.getByRole('option')).toHaveText(['Native default', 'Accept edits']);
  await page.screenshot({ path: info.outputPath('composer-native-permissions-855.png') });
  await page.getByRole('option', { name: 'Accept edits', exact: true }).click();
  await expect.poll(() => state.patches).toEqual([{ native: { permission: 'acceptEdits' } }]);
  await expect(permission).toHaveAccessibleName('Native permissions Accept edits');
  await expect(permission).toBeFocused();
  clean(state);
});

test('native row collapses when compact controls cannot fit and explicit expand keeps every action reachable', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 390, height: 769 });
  const state = await setup(page, baseURL, { native: true });
  await expect(page.getByRole('button', { name: 'Expand composer', exact: true })).toBeVisible();
  await expect(form(page).getByRole('button', { name: /^Native permissions/ })).toBeHidden();
  await page.getByLabel('Message your agent').fill('Preserved narrow draft');
  const text = await page.getByLabel('Message your agent').boundingBox(), action = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  expect(action.x).toBeGreaterThan(text.x + text.width);
  await page.screenshot({ path: info.outputPath('composer-collapsed-390.png') });
  await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
  const permission = form(page).getByRole('button', { name: /^Native permissions/ });
  await expect(permission).toBeVisible(); await permission.click();
  const popup = page.getByRole('listbox', { name: 'Permissions', exact: true });
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape'); await expect(permission).toBeFocused();
  expect(await form(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.getByLabel('Message your agent')).toHaveValue('Preserved narrow draft');
  await page.setViewportSize({ width: 855, height: 769 });
  await expect(form(page)).not.toHaveClass(/composer-collapsed/);
  await oneRowWithinForm(page); clean(state);
});

test('resizing an open native menu into collapsed layout dismisses it and focuses the visible expand control', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 855, height: 769 });
  const state = await setup(page, baseURL, { native: true });
  await form(page).getByRole('button', { name: /^Native permissions/ }).click();
  await expect(page.getByRole('listbox', { name: 'Permissions', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 769 });
  await expect(page.getByRole('listbox', { name: 'Permissions', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand composer', exact: true })).toBeFocused();
  clean(state);
});

// The all-harness matrix already lives in folder-composer.spec.mjs; exercise the
// shared metadata contract here, including the desktop one-option distinction.
test('native Thinking follows reported names and guards without inventing unsupported levels', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL, { native: true });
  const thinking = form(page).getByRole('button', { name: /^Native thinking level/ });
  const original = state.native.settings;
  await expect(thinking).toBeVisible(); await expect(thinking).toBeDisabled(); // sole selected High
  state.native.settings = null; await page.reload();
  await expect(thinking).toHaveAccessibleName('Native thinking level Thinking'); await expect(thinking).toBeDisabled();
  await thinking.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('listbox')).toHaveCount(0);
  state.native.settings = { ...original, thinkingLevels: [] }; await page.reload();
  await expect(thinking).toBeVisible(); await expect(thinking).toBeDisabled();
  state.native.settings.thinkingLevels = [{ id: 'deep', label: 'Reported deep reasoning' }]; await page.reload();
  await expect(thinking).toBeEnabled(); await thinking.click();
  await expect(page.getByRole('listbox')).toHaveAccessibleName('Thinking Level');
  await expect(page.getByRole('option')).toHaveText(['Reported deep reasoning']);
  await page.screenshot({ path: info.outputPath('native-reported-thinking.png'), animations: 'disabled' });
  await page.getByRole('option', { name: 'Reported deep reasoning', exact: true }).click();
  await expect.poll(() => state.patches).toEqual([{ native: { thinking: 'deep' } }]);
  await expect(thinking).toHaveAccessibleName('Native thinking level Reported deep reasoning'); await expect(thinking).toBeDisabled();
  state.native.settings.thinkingLevels.push({ id: 'quick_reasoning', label: '  ' }); state.native.settings.canConfigure = false; await page.reload();
  await expect(thinking).toBeDisabled();
  state.native.settings.canConfigure = true; await page.reload(); await expect(thinking).toBeEnabled();
  await thinking.click(); await expect(page.getByRole('option')).toHaveText(['Reported deep reasoning', 'Quick Reasoning']); await page.keyboard.press('Escape');
  state.disabled = true; await state.refresh('run.started'); await expect(thinking).toBeDisabled();
  clean(state);
});
