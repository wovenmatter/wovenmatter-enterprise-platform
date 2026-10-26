import { test, expect } from '@playwright/test';
import { parityFixture, base, project, folder } from './ui-parity.fixture.mjs';

// Browser plugin not available. Synthetic requests never reach a provider.
// Flow: choose root -> preserve draft -> first send -> fixed binding -> reload.
test.use({ storageState: { cookies: [], origins: [] } });
const root = `${base}/workspaces/${project.id}`;
const second = { ...folder, id: 'second-folder', name: 'Second folder', rootPath: '.WovenMatter/Second', pinned: false };
const picker = page => page.getByRole('button', { name: /^Conversation folder/ });
async function setup(page, baseURL, harness = 'pi') {
  const state = await parityFixture(page, { baseURL });
  Object.assign(state, { chat: null, messages: [], creates: [], sends: [], patches: [], rejectCreate: false, rejectSend: false, uncertainSend: false, errors: [] });
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/projects/parity-project/folders', route => route.fulfill({ json: { items: [folder, second] } }));
  await page.route('**/projects/parity-project/agent-settings', route => route.fulfill({ json: { defaultHarness: harness, agents: {} } }));
  await page.route('**/projects/parity-project/conversations', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: state.chat ? [state.chat] : [] } });
    const body = route.request().postDataJSON(); state.creates.push(body);
    if (state.rejectCreate) { state.rejectCreate = false; return route.fulfill({ status: 409, json: { error: { message: 'Synthetic creation rejected' } } }); }
    state.chat = { id: 'composer-chat', title: 'Composer fixture chat', mode: 'write', effectiveMode: 'write', harness: body.harness, pi: {}, model: body.model || 'parity-model', folderId: body.folderId, workingDirectory: null, workspaceLocked: false, createdBy: 'different-workspace-member', lastEventId: 0 };
    return route.fulfill({ status: 201, json: state.chat });
  });
  await page.route('**/api/conversations/composer-chat**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    if (path.endsWith('/organization')) { state.patches.push(body); state.chat.folderId = body.folderId; return route.fulfill({ json: state.chat }); }
    if (path.endsWith('/messages')) {
      if (request.method() === 'GET') return route.fulfill({ json: { items: state.messages, hasMore: false } });
      state.sends.push(body);
      if (state.rejectSend) { state.rejectSend = false; return route.fulfill({ status: 400, json: { error: { message: 'Synthetic message rejected' } } }); }
      if (state.uncertainSend) { state.uncertainSend = false; return route.fulfill({ status: 503, json: { error: { message: 'Synthetic delivery unknown' } } }); }
      state.chat.workspaceLocked = true;
      state.chat.workingDirectory = state.chat.folderId === folder.id ? `/workspace/${folder.rootPath}` : state.chat.folderId === second.id ? `/workspace/${second.rootPath}` : '/workspace/.WovenMatter/scratch/2026-10-23-composer-chat';
      state.messages = [{ id: 'fixture-message', role: 'user', authorId: 'parity-owner', requestId: body.requestId, content: body.content, kind: body.kind, attachments: body.attachments ?? [], createdAt: '2026-10-23T12:00:00Z' }];
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/native')) return route.fulfill({ json: { configured: {}, settings: { model: state.chat.model, thinking: 'high', permission: 'default', models: [], thinkingLevels: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }], permissions: [{ id: 'default', label: 'Native default' }, { id: 'acceptEdits', label: 'Accept edits' }], canConfigure: true }, interactions: [] } });
    if (path.endsWith('/runs')) return route.fulfill({ json: { items: [] } });
    if (path.endsWith('/activities')) return route.fulfill({ json: { items: [], cursor: '0', hasMore: false } });
    if (request.method() === 'PATCH') { state.patches.push(body); Object.assign(state.chat, body); return route.fulfill({ json: state.chat }); }
    return route.fulfill({ json: state.chat });
  });
  return state;
}
async function choose(page, name) {
  await picker(page).click(); await page.getByRole('option', { name, exact: true }).click();
}
const clean = state => { expect(state.errors).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]); expect(state.writes).toEqual([]); };

for (const width of [1280, 390]) test(`folder first send and persisted binding at ${width}px`, async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL);
  await page.setViewportSize({ width, height: 844 }); await page.goto(root);
  const input = page.getByLabel('Message your agent'); await input.fill('Unsent folder fixture');
  await choose(page, folder.name); await expect(input).toHaveValue('Unsent folder fixture');
  const box = await picker(page).boundingBox(), text = await input.boundingBox(); expect(box.y + box.height).toBeLessThanOrEqual(text.y);
  await picker(page).click(); await expect(page.getByRole('option')).toHaveText(['All Workspaces', folder.name, second.name]); await page.keyboard.press('Escape');
  const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: 'Collapse composer', exact: true }).click(); await expect(page.getByRole('button', { name: /^Model / })).toBeHidden(); await expect(input).toHaveValue('Unsent folder fixture');
  await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page).toHaveURL(/conversation=composer-chat/); await expect(picker(page)).toHaveAttribute('aria-disabled', 'true');
  expect(state.creates[0].folderId).toBe(folder.id); expect(state.sends).toHaveLength(1);
  await expect(picker(page)).toContainText(folder.name); await expect(picker(page)).toHaveAttribute('title', new RegExp('/workspace/\\.WovenMatter/Records'));
  const actions = page.getByRole('button', { name: 'Conversation actions', exact: true });
  await actions.focus(); await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Conversation actions', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveText(['Export messages', 'Export full run', 'Native history', 'Stop background work', 'Conversation settings', 'Move to Trash']);
  const popup = await menu.boundingBox(); expect(popup.x).toBeGreaterThanOrEqual(0); expect(popup.x + popup.width).toBeLessThanOrEqual(width); expect(popup.y + popup.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: info.outputPath(`conversation-actions-${width}.png`) });
  await page.keyboard.press('Escape'); await expect(actions).toBeFocused();
  if (width === 390) await page.getByRole('button', { name: 'Show navigation sidebar', exact: true }).click();
  await page.locator('[data-folder-selection]').filter({ hasText: second.name }).click();
  await expect(picker(page)).toContainText(folder.name); expect(state.patches).toEqual([]);
  await page.reload(); await expect(picker(page)).toHaveAttribute('aria-disabled', 'true'); await expect(picker(page)).toContainText(folder.name);
  await page.screenshot({ path: info.outputPath(`bound-folder-${width}.png`) }); clean(state);
});

test('known creation and first-message rejections preserve editable draft and allow another folder', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL); state.rejectCreate = true;
  await page.goto(root); const input = page.getByLabel('Message your agent'); await input.fill('Retained rejection draft');
  await choose(page, folder.name); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic creation rejected'); await expect(input).toHaveValue('Retained rejection draft');
  await choose(page, 'All Workspaces'); state.rejectSend = true;
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page).toHaveURL(/conversation=composer-chat/);
  await expect(input).toHaveValue('Retained rejection draft'); await expect(input).toBeEditable(); await expect(picker(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('alert')).toContainText('Synthetic message rejected');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-sidebar-reveal]')).toBeVisible();
  const banner = await page.getByRole('alert').boundingBox(), reopen = await page.locator('[data-sidebar-reveal]').boundingBox();
  expect(banner.x).toBeGreaterThanOrEqual(reopen.x + reopen.width);
  await choose(page, second.name); await expect(picker(page)).toContainText(second.name); await expect(input).toHaveValue('Retained rejection draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(picker(page)).toHaveAttribute('aria-disabled', 'true');
  expect(state.sends).toHaveLength(2); expect(state.sends[1].requestId).not.toBe(state.sends[0].requestId); expect(state.patches).toEqual([{ folderId: second.id }]); clean(state);
});

test('unknown delivery retains identity and locks changes until same-message retry; All Workspaces survives reload', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL); state.uncertainSend = true;
  await page.goto(root); await page.getByLabel('Message your agent').fill('Unknown delivery draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page).toHaveURL(/conversation=composer-chat/);
  await expect(picker(page)).toHaveAttribute('aria-disabled', 'true'); await expect(page.getByLabel('Message your agent')).not.toBeEditable();
  await expect(page.locator('.composer-status')).toHaveText('Delivery unconfirmed'); await expect(page.locator('.composer-status')).toBeVisible();

  await page.reload(); await page.getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect(page.getByLabel('Message your agent')).toHaveValue(''); expect(state.sends).toHaveLength(2); expect(state.sends[1].requestId).toBe(state.sends[0].requestId);
  expect(state.creates).toHaveLength(1); expect(state.creates[0].folderId).toBe(null);
  await page.reload(); await expect(picker(page)).toContainText('All Workspaces'); await expect(picker(page)).toHaveAttribute('title', /scratch/); await expect(picker(page)).toHaveAttribute('aria-disabled', 'true'); clean(state);
});

test('unavailable named folder cannot silently create scratch', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL); await page.goto(`${root}?folder=removed-folder`);
  await page.getByLabel('Message your agent').fill('Keep this draft'); await expect(picker(page)).toContainText('Unavailable folder');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled(); expect(state.creates).toEqual([]);
  await choose(page, 'All Workspaces'); await expect(page.getByLabel('Message your agent')).toHaveValue('Keep this draft'); await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled(); clean(state);
});

test('attachment-only unknown delivery preserves references through folder change, reload and exact retry', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL); state.uncertainSend = true;
  await page.route('**/projects/parity-project/workspace-content?kind=note', route => route.fulfill({ json: { items: [{ id: 'fixture-note', kind: 'note', title: 'Fixture note', body: 'Synthetic note', revision: 1 }] } }));
  await page.goto(root);
  await page.getByRole('button', { name: 'Add files or photos', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Attach note', exact: true }).click();
  await page.getByRole('button', { name: /^Attach note: / }).first().click();
  await choose(page, folder.name);
  await expect(page.getByRole('list', { name: 'Attachments', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page).toHaveURL(/conversation=composer-chat/);
  await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: 'Attachments', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toBeHidden();
  expect(state.sends).toHaveLength(2); expect(state.sends[1]).toEqual(state.sends[0]);
  expect(state.sends[0].content).toBe(''); expect(state.sends[0].attachments).toHaveLength(1);
  expect(state.creates[0].folderId).toBe(folder.id); clean(state);
});

for (const width of [855, 1280]) test(`composer visual review at ${width}px`, async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL); await page.setViewportSize({ width, height: 769 });
  await page.goto(root); await choose(page, folder.name); await page.getByLabel('Message your agent').fill('Review the workspace material');
  await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`composer-${width}.png`) });
  await page.getByRole('button', { name: 'Add files or photos', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.screenshot({ path: info.outputPath(`composer-attachments-${width}.png`) }); clean(state);
});

for (const harness of ['codex', 'claude_code', 'grok_build', 'opencode']) test(`${harness} uses real native model/thinking/key menus inside composer`, async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL, harness); await page.goto(root); await page.getByLabel('Message your agent').fill('Native fixture');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page).toHaveURL(/conversation=composer-chat/);
  const controls = page.locator('.composer-area form .composer-controls');
  await expect(controls.getByRole('button', { name: /^Native model/ })).toBeVisible();
  await controls.getByRole('button', { name: /^Native thinking level/ }).click(); await expect(page.getByRole('listbox')).toHaveAccessibleName('Thinking Level'); await page.getByRole('option', { name: 'Low', exact: true }).click();
  await expect.poll(() => state.patches).toEqual([{ native: { thinking: 'low' } }]);
  await controls.getByRole('button', { name: /^Native permissions/ }).click(); await expect(page.getByRole('listbox')).toHaveAccessibleName('Permissions'); await expect(page.getByRole('option')).toHaveText(['Native default', 'Accept edits']);
  expect(await controls.locator('.lucide-key-round').count()).toBe(1); await page.screenshot({ path: info.outputPath(`${harness}-permissions.png`) }); clean(state);
});
