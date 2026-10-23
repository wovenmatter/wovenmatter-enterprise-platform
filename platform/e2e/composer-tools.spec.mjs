import { test, expect } from '@playwright/test';
import { parityFixture, workspace, base, project, folder } from './ui-parity.fixture.mjs';

// Browser plugin not available. All data is synthetic; the fixture blocks
// external traffic and every unregistered mutation, including provider calls.
test.use({ storageState: { cookies: [], origins: [] } });
const defaults = { notes: true, history: true, usage: true, calendar: true, library: true };
const trigger = page => page.getByRole('button', { name: 'Tools', exact: true });
const popup = page => page.getByRole('dialog', { name: 'Conversation tools', exact: true });
const toggle = (page, name) => popup(page).getByRole('switch', { name, exact: true });
const root = `${base}/workspaces/${project.id}?folder=all`;

async function setup(page, baseURL, welcome = false) {
  const state = await parityFixture(page, { baseURL });
  Object.assign(state, { tools: { ...defaults }, patches: [], creates: [], sends: [], errors: [], expectedFailures: [], fail: false, pending: null });
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => {
    if (!['error', 'warning'].includes(message.type())) return;
    if (message.text().includes('the server responded with a status of 403') && state.fail) state.expectedFailures.push(message.text());
    else state.errors.push(message.text());
  });
  const chat = () => ({ id: 'parity-chat', title: 'Retained parity conversation', harness: 'pi', pi: {}, model: 'parity-model', folderId: state.folderId ?? folder.id, workspaceLocked: state.sends.length > 0, lastEventId: 0, createdBy: 'parity-owner', tools: state.tools });
  state.exists = !welcome;
  await page.route('**/projects/parity-project/conversations', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: state.exists ? [chat()] : [] } });
    const body = route.request().postDataJSON(); state.creates.push(body); state.tools = body.tools; state.folderId = body.folderId; state.exists = true;
    return route.fulfill({ status: 201, json: chat() });
  });
  await page.route('**/api/conversations/parity-chat', route => route.fulfill({ json: chat() }));
  await page.route('**/api/conversations/parity-chat/tools', async route => {
    expect(route.request().method()).toBe('PATCH');
    const body = route.request().postDataJSON(); state.patches.push(body);
    if (state.pending) await state.pending;
    if (state.fail) return route.fulfill({ status: 403, json: { error: { message: 'Synthetic tool setting rejected' } } });
    state.tools = { ...state.tools, [body.group]: body.enabled };
    return route.fulfill({ json: { settings: state.tools } });
  });
  await page.route('**/api/conversations/parity-chat/messages', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: [], hasMore: false } });
    state.sends.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } });
  });
  await page.goto(welcome ? root : workspace);
  await expect(page).toHaveURL(new URL(welcome ? root : workspace, baseURL).href);
  await expect(page).toHaveTitle(/WovenMatter/);
  await expect(page.getByLabel('Message your agent')).toBeVisible();
  if (page.viewportSize().width < 500) {
    // The desktop-compatible narrow row starts collapsed; users can explicitly
    // expand it to reach the complete tool controls.
    await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
  }
  await expect(trigger(page)).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  return state;
}
const clean = state => { for (const key of ['writes', 'external', 'unknown', 'errors']) expect(state[key], key).toEqual([]); };

test('draft tools preserve text and folder selection and become the created chat settings', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL, true);
  const input = page.getByLabel('Message your agent'); await input.fill('Retained tools fixture draft');
  await trigger(page).click();
  await expect(popup(page).getByRole('switch')).toHaveCount(5);
  for (const name of ['Notes', 'Conversation history', 'Usage data', 'Calendar', 'Library']) await expect(toggle(page, name)).toBeChecked();
  await expect(popup(page)).toContainText('Shell access follows workspace permissions');
  await expect(popup(page)).toContainText('Attached notes and conversations remain available to read');
  await toggle(page, 'Notes').press('Space'); await expect(toggle(page, 'Notes')).not.toBeChecked();
  expect(state.patches).toEqual([]); await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
  await page.getByRole('button', { name: /^Conversation folder/ }).click(); await page.getByRole('option', { name: folder.name, exact: true }).click();
  await expect(input).toHaveValue('Retained tools fixture draft');
  await trigger(page).click(); await expect(toggle(page, 'Notes')).not.toBeChecked();
  await page.screenshot({ path: info.outputPath('draft-tools.png') }); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page).toHaveURL(/conversation=parity-chat/);
  expect(state.creates).toHaveLength(1); expect(state.creates[0].tools).toEqual({ ...defaults, notes: false }); expect(state.creates[0].folderId).toBe(folder.id);
  expect(state.sends[0].content).toBe('Retained tools fixture draft');
  await trigger(page).click(); await expect(toggle(page, 'Notes')).not.toBeChecked(); clean(state);
});

test('persisted tools wait for save, retain the popup and recover the initiating keyboard focus', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL); let release;
  state.pending = new Promise(resolve => { release = resolve; });
  await page.getByLabel('Message your agent').fill('Keep this unsent draft');
  await trigger(page).focus(); await page.keyboard.press('ArrowDown'); await expect(toggle(page, 'Notes')).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(toggle(page, 'Conversation history')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(popup(page)).toBeVisible(); await expect(popup(page).getByRole('status')).toHaveText('Saving tool settings…');
  for (const name of ['Notes', 'Conversation history', 'Usage data', 'Calendar', 'Library']) await expect(toggle(page, name)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  expect(state.patches).toEqual([{ group: 'history', enabled: false }]); release();
  await expect(toggle(page, 'Conversation history')).toBeEnabled(); await expect(toggle(page, 'Conversation history')).not.toBeChecked();
  await expect(toggle(page, 'Conversation history')).toBeFocused(); await expect(page.getByLabel('Message your agent')).toHaveValue('Keep this unsent draft');
  await page.screenshot({ path: info.outputPath('saved-tools.png') });
  await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
  await page.reload(); await trigger(page).click(); await expect(toggle(page, 'Conversation history')).not.toBeChecked(); clean(state);
});

test('a rejected tool update retains confirmed settings and draft and recovers focus', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL); state.fail = true;
  await page.getByLabel('Message your agent').fill('Retain rejected update draft');
  await trigger(page).click(); await toggle(page, 'Calendar').focus(); await page.keyboard.press('Space');
  await expect(popup(page).getByRole('alert')).toContainText('Synthetic tool setting rejected');
  await expect(toggle(page, 'Calendar')).toBeChecked(); await expect(toggle(page, 'Calendar')).toBeEnabled(); await expect(toggle(page, 'Calendar')).toBeFocused();
  await expect(page.getByLabel('Message your agent')).toHaveValue('Retain rejected update draft');
  expect(state.tools).toEqual(defaults); expect(state.patches).toEqual([{ group: 'calendar', enabled: false }]);
  await page.screenshot({ path: info.outputPath('rejected-tools.png') }); clean(state);
});

for (const width of [1280, 390]) test(`tools popup stays in the ${width}px viewport and supports dismissal and popup arbitration`, async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width, height: 600 }); const state = await setup(page, baseURL);
  await trigger(page).click(); await expect(toggle(page, 'Notes')).toBeFocused();
  const box = await popup(page).boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.y + box.height).toBeLessThanOrEqual(600);
  await page.keyboard.press('End'); await expect(toggle(page, 'Library')).toBeFocused();
  await page.screenshot({ path: info.outputPath(`tools-${width}.png`) });
  await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  // A short mobile viewport legitimately places the popup above the composer,
  // covering the textarea center. Click an exposed corner, not the overlay.
  await trigger(page).click();
  const input = page.getByLabel('Message your agent');
  const exposed = await input.evaluate(node => {
    const box = node.getBoundingClientRect();
    return [{ x: 2, y: 2 }, { x: box.width - 2, y: 2 }, { x: 2, y: box.height - 2 }, { x: box.width - 2, y: box.height - 2 }]
      .find(point => document.elementFromPoint(box.x + point.x, box.y + point.y) === node);
  });
  expect(exposed, 'textarea has an exposed target outside the popup').toBeTruthy();
  await input.click({ position: exposed }); await expect(popup(page)).toHaveCount(0); await expect(input).toBeFocused();
  await trigger(page).click(); await page.getByRole('button', { name: /^Message mode/ }).click(); await expect(popup(page)).toHaveCount(0); await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape'); clean(state);
});
