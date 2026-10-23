import { test, expect } from '@playwright/test';
import { parityFixture, base, folder, project } from './ui-parity.fixture.mjs';

// Browser plugin not available. Welcome defaults are tested against synthetic
// authorized catalogs and captured requests; no provider is contacted.
test.use({ storageState: { cookies: [], origins: [] } });
const root = `${base}/workspaces/${project.id}?folder=all`;
const catalog = [
  { id: 'first-model', name: 'First catalog model', provider: 'openai', thinkingLevels: ['off', 'high'], defaultThinkingLevel: 'high' },
  { id: 'personal-model', name: 'Personal model', provider: 'openrouter', thinkingLevels: [] },
  { id: 'workspace-model', name: 'Workspace model', provider: 'anthropic', thinkingLevels: ['off', 'low', 'high'], defaultThinkingLevel: 'low' },
];
const model = page => page.getByRole('button', { name: /^Model / });
const thinking = page => page.getByRole('button', { name: /^Thinking level / });
const sender = page => page.getByRole('button', { name: 'Send message', exact: true });
const draft = page => page.getByLabel('Message your agent');
const configured = { model: 'workspace-model', thinking: 'high', codeMode: 'only', subagentConcurrency: 4 };

async function setup(page, baseURL, { settings = { defaultHarness: 'pi', agents: { pi: configured } }, personal = 'personal-model', models = catalog, holdModels = false } = {}) {
  const state = await parityFixture(page, { baseURL });
  Object.assign(state, { chat: null, creates: [], sends: [], errors: [] });
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) state.errors.push(message.text()); });
  await page.route('**/enterprise/api/session', route => route.fulfill({ json: { user: { id: 'parity-owner', role: 'owner', name: 'Synthetic owner', email: 'parity@example.test', theme: 'green', defaultModel: personal }, csrfToken: null } }));
  await page.route('**/projects/parity-project/agent-settings', route => route.fulfill({ json: settings }));
  let release;
  const pending = new Promise(resolve => { release = resolve; }); state.releaseModels = release;
  await page.route('**/organizations/parity-org/inference/models', async route => {
    if (holdModels) await pending;
    return route.fulfill({ json: { items: models } });
  });
  await page.route('**/projects/parity-project/conversations', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: state.chat ? [state.chat] : [] } });
    const input = route.request().postDataJSON(); state.creates.push(input);
    state.chat = { id: 'welcome-default-chat', title: 'Welcome defaults fixture', harness: input.harness, model: input.model, pi: input.pi, folderId: input.folderId, tools: input.tools, createdBy: 'parity-owner', workspaceLocked: false, lastEventId: 0 };
    return route.fulfill({ status: 201, json: state.chat });
  });
  await page.route('**/api/conversations/welcome-default-chat**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/messages')) {
      if (request.method() === 'GET') return route.fulfill({ json: { items: state.sends.map((message, i) => ({ ...message, id: `message-${i}`, role: 'user', authorId: 'parity-owner', createdAt: '2026-10-23T12:00:00Z' })), hasMore: false } });
      state.sends.push(request.postDataJSON()); state.chat.workspaceLocked = true; return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/runs')) return route.fulfill({ json: { items: [] } });
    if (path.endsWith('/activities')) return route.fulfill({ json: { items: [], cursor: '0', hasMore: false } });
    expect(request.method()).toBe('GET'); return route.fulfill({ json: state.chat });
  });
  await page.goto(root); await expect(page).toHaveURL(new URL(root, baseURL).href); await expect(page).toHaveTitle(/WovenMatter/);
  await expect(draft(page)).toBeVisible(); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  return state;
}
function clean(state) { for (const key of ['errors', 'external', 'unknown', 'writes']) expect(state[key], key).toEqual([]); }
async function chooseModel(page, label) { await model(page).click(); await page.getByRole('option', { name: label, exact: true }).click(); }
async function chooseThinking(page, label) { await thinking(page).click(); await page.getByRole('option', { name: label, exact: true }).click(); }
async function send(page, state) {
  await sender(page).click(); await expect(page).toHaveURL(/conversation=welcome-default-chat/); expect(state.creates).toHaveLength(1); expect(state.sends).toHaveLength(1);
}

test('welcome resolves workspace defaults and preserves complete Pi configuration on first send', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL);
  await expect(model(page)).toContainText('Workspace model'); await expect(thinking(page)).toContainText('High');
  const agent = page.getByRole('button', { name: /^Agent / });
  await expect(agent.locator('img.agent-logo')).toHaveCount(1); await expect(agent.locator('.lucide-cpu')).toHaveCount(0); await expect(model(page).locator('.lucide-cpu')).toHaveCount(1);
  await thinking(page).click(); await expect(page.getByRole('option')).toHaveText(['Model default (Low)', 'Off', 'Low', 'High']); await page.keyboard.press('Escape');
  await draft(page).fill('Use the real welcome defaults');
  await page.screenshot({ path: info.outputPath('resolved-welcome-defaults.png') }); await send(page, state);
  expect(state.creates[0].model).toBe('workspace-model'); expect(state.creates[0].pi).toEqual({ thinking: 'high', codeMode: 'only', subagentConcurrency: 4 }); clean(state);
});

for (const example of [
  { label: 'valid personal default', personal: 'personal-model', agents: {}, expected: 'Personal model', id: 'personal-model' },
  { label: 'unavailable personal default falls back to catalog', personal: 'removed-model', agents: {}, expected: 'First catalog model', id: 'first-model' },
  { label: 'empty workspace default preserves personal fallback', personal: 'personal-model', agents: { pi: { model: '' } }, expected: 'Personal model', id: 'personal-model' },
]) test(example.label, async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, { personal: example.personal, settings: { defaultHarness: 'pi', agents: example.agents } });
  await expect(model(page)).toContainText(example.expected); await draft(page).fill('Default precedence fixture'); await send(page, state);
  expect(state.creates[0].model).toBe(example.id); clean(state);
});

test('model and thinking choices survive a folder change and explicitly override configured thinking', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL); await draft(page).fill('Retain all welcome choices');
  await chooseModel(page, 'First catalog model'); await expect(thinking(page)).toContainText('Model default (High)');
  await thinking(page).click(); await expect(page.getByRole('option')).toHaveText(['Model default (High)', 'Off', 'High']); await page.getByRole('option', { name: 'Off', exact: true }).click();
  await page.getByRole('button', { name: /^Conversation folder/ }).click(); await page.getByRole('option', { name: folder.name, exact: true }).click();
  await expect(draft(page)).toHaveValue('Retain all welcome choices'); await expect(model(page)).toContainText('First catalog model'); await expect(thinking(page)).toContainText('Off');
  await chooseThinking(page, 'Model default (High)'); await send(page, state);
  expect(state.creates[0]).toMatchObject({ model: 'first-model', folderId: folder.id, pi: { codeMode: 'only', subagentConcurrency: 4 } }); expect(state.creates[0].pi).not.toHaveProperty('thinking'); clean(state);
});

test('stale workspace model remains unavailable until an explicit selection', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, { settings: { defaultHarness: 'pi', agents: { pi: { ...configured, model: 'removed-workspace-model' } } } });
  await draft(page).fill('Keep unavailable defaults draft'); await expect(model(page)).toContainText('removed-workspace-model (unavailable)'); await expect(sender(page)).toBeDisabled();
  await model(page).click(); await expect(page.getByRole('option', { name: 'removed-workspace-model (unavailable)', exact: true })).toBeDisabled(); await page.getByRole('option', { name: 'First catalog model', exact: true }).click();
  await expect(draft(page)).toHaveValue('Keep unavailable defaults draft'); await expect(sender(page)).toBeEnabled(); await send(page, state);
  expect(state.creates[0].model).toBe('first-model'); expect(state.creates[0].pi).not.toHaveProperty('thinking'); clean(state);
});

test('stale thinking is explicit and can be cleared without losing other Pi defaults', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, { settings: { defaultHarness: 'pi', agents: { pi: { ...configured, thinking: 'max' } } } });
  await draft(page).fill('Keep stale thinking draft'); await expect(thinking(page)).toContainText('Max (unavailable)'); await expect(sender(page)).toBeDisabled();
  await thinking(page).click(); await expect(page.getByRole('option', { name: 'Max (unavailable)', exact: true })).toBeDisabled(); await page.getByRole('option', { name: 'Low', exact: true }).click();
  await send(page, state); expect(state.creates[0].pi).toEqual({ thinking: 'low', codeMode: 'only', subagentConcurrency: 4 }); clean(state);
});

test('catalog loading blocks send and native welcome defers unreported thinking choices', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, { holdModels: true, settings: { defaultHarness: 'pi', agents: { pi: configured, claude_code: { model: 'personal-model', thinking: 'high', permission: 'ask' } } } });
  await draft(page).fill('Wait for authoritative catalog'); await expect(model(page)).toBeDisabled(); await expect(sender(page)).toBeDisabled(); expect(state.creates).toEqual([]);
  state.releaseModels(); await expect(model(page)).toBeEnabled(); await expect(sender(page)).toBeEnabled();
  await page.getByRole('button', { name: /^Agent / }).click(); await page.getByRole('option', { name: /^Claude Code / }).click();
  await expect(model(page)).toContainText('Personal model'); await expect(thinking(page)).toHaveCount(0); await expect(page.getByRole('button', { name: /^Native permissions/ })).toHaveCount(0);
  await expect(draft(page)).toHaveValue('Wait for authoritative catalog');
  await page.getByRole('button', { name: /^Agent / }).click(); await page.getByRole('option', { name: /^Pi Durable / }).click();
  await expect(model(page)).toContainText('Workspace model'); await expect(thinking(page)).toContainText('High'); clean(state);
});

test('an empty catalog cannot create a doomed native first message', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, { models: [], settings: { defaultHarness: 'codex', agents: {} } });
  await draft(page).fill('Keep until a model exists'); await expect(model(page)).toBeEnabled(); await expect(sender(page)).toBeDisabled();
  await model(page).click(); await expect(page.getByText('No models are available. An administrator can connect a provider in Connections.', { exact: true })).toBeVisible(); expect(state.creates).toEqual([]); clean(state);
});
