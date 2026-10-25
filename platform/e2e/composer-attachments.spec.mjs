import { test as baseTest, expect } from '@playwright/test';
import { parityFixture, workspace, project, folder, org } from './ui-parity.fixture.mjs';

// Browser plugin not available. This fixture intercepts every API request and
// forbids external requests; uploaded bytes and references are synthetic.
const test = baseTest.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await use(page);
    expect(errors, 'document and console errors').toEqual([]);
  },
});
test.use({ storageState: { cookies: [], origins: [] } });
const trigger = page => page.getByRole('button', { name: 'Add files or photos', exact: true });
const chips = page => page.getByRole('list', { name: 'Attachments', exact: true });
const clean = state => { for (const key of ['writes', 'external', 'unknown']) expect(state[key], key).toEqual([]); };
const note = { id: 'attachment-note', projectId: project.id, kind: 'note', title: 'Research attachment', body: 'Synthetic searchable retained detail', folderId: folder.id, data: { format: 'markdown' }, revision: 1 };
const chat = { id: 'parity-chat', title: 'Retained parity conversation', harness: 'pi', folderId: folder.id, createdBy: 'parity-owner' };

async function setup(page, baseURL) {
  const state = await parityFixture(page, { baseURL });
  state.noteReads = 0; state.chatReads = 0;
  await page.route('**/projects/parity-project/workspace-content?kind=note', route => {
    state.noteReads++; return route.fulfill({ json: { items: [note] } });
  });
  await page.route('**/projects/parity-project/conversations', route => {
    state.chatReads++; return route.fulfill({ json: { items: [chat] } });
  });
  await page.goto(workspace);
  await expect(page).toHaveURL(new URL(workspace, baseURL).href);
  await expect(page).toHaveTitle(/WovenMatter/);
  await expect(page.getByLabel('Message your agent')).toBeVisible();
  await expect(trigger(page)).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  return state;
}

test('attachment menu matches desktop and attaches searchable authorized references with removable chips', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL);
  await trigger(page).click();
  const menu = page.getByRole('menu', { name: 'Add files or photos', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveText(['Upload photos or files', 'Attach note', 'Attach conversation']);
  const noteReads = state.noteReads;
  await page.screenshot({ path: info.outputPath('attachment-menu.png') });
  await menu.getByRole('menuitem', { name: 'Attach note', exact: true }).click();
  const notes = page.getByRole('dialog', { name: 'Attach note', exact: true });
  await expect(notes).toBeVisible(); await expect(menu).toHaveCount(0);
  await expect.poll(() => state.noteReads).toBeGreaterThan(noteReads);
  await notes.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('searchable retained');
  await notes.getByRole('button', { name: `Attach note: ${note.title}`, exact: true }).click();
  await expect(notes).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  await expect(chips(page)).toContainText(note.title);
  await trigger(page).click(); await page.getByRole('menuitem', { name: 'Attach note', exact: true }).click();
  await expect(notes.getByRole('button', { name: `Attach note: ${note.title}`, exact: true })).toBeDisabled();
  await notes.getByRole('searchbox').fill('No matching fixture');
  await expect(notes.getByText('No matching notes. Try a different search.')).toBeVisible();
  await notes.getByRole('button', { name: 'Cancel', exact: true }).click();
  const chatReads = state.chatReads;
  await trigger(page).click(); await page.getByRole('menuitem', { name: 'Attach conversation', exact: true }).click();
  const chats = page.getByRole('dialog', { name: 'Attach conversation', exact: true });
  await expect.poll(() => state.chatReads).toBeGreaterThan(chatReads);
  await chats.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill('Pi Durable');
  await chats.getByRole('button', { name: `Attach conversation: ${chat.title}`, exact: true }).click();
  await expect(chips(page).getByRole('listitem')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('reference-attachment-chips.png') });
  await chips(page).getByRole('button', { name: `Remove ${note.title}`, exact: true }).click();
  await expect(chips(page).getByRole('listitem')).toHaveCount(1); await expect(chips(page)).toContainText(chat.title);
  await chips(page).getByRole('button', { name: `Remove ${chat.title}`, exact: true }).click();
  await expect(chips(page)).toHaveCount(0); clean(state);
});

test('upload uses project authorization and unique paths, blocks send while pending and retains partial errors', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL), uploads = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/enterprise/api/files/upload', async route => {
    uploads.push(route.request().postDataBuffer().toString('utf8'));
    await pending;
    await route.fulfill({ json: { items: [{ id: 'attachment-file', name: 'fixture.txt', size: 23 }], errors: [{ path: '2/fixture.png', message: 'Synthetic image unavailable' }] } });
  });
  await page.getByLabel('Message your agent').fill('Retained unsent fixture');
  await trigger(page).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Upload photos or files', exact: true }).click();
  await (await chooser).setFiles([
    { name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attached file') },
    { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  ]);
  await expect(page.getByRole('status').filter({ hasText: 'Uploading attachments…' })).toBeVisible();
  await expect(trigger(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).toContain(`name="orgId"\r\n\r\n${org.id}`);
  expect(uploads[0]).toContain(`name="projectId"\r\n\r\n${project.id}`);
  expect(uploads[0]).toMatch(/name="path"\r\n\r\n\.WovenMatter\/attachments\/[0-9a-f-]{36}/);
  expect(uploads[0]).toContain('["1/fixture.txt","2/fixture.png"]');
  release();
  await expect(trigger(page)).toBeEnabled();
  await expect(chips(page).getByRole('link', { name: 'Open fixture.txt', exact: true })).toHaveAttribute('href', `/enterprise/api/files/attachment-file/content?projectId=${project.id}`);
  await expect(page.getByRole('alert')).toContainText('Synthetic image unavailable');
  await expect(page.getByLabel('Message your agent')).toHaveValue('Retained unsent fixture');
  await page.screenshot({ path: info.outputPath('upload-partial-success.png') });
  await page.getByRole('button', { name: 'Dismiss attachment error', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await chips(page).getByRole('button', { name: 'Remove fixture.txt', exact: true }).click();
  await expect(chips(page)).toHaveCount(0); clean(state);
});

test('uploads reject oversized files and bound a message to eight files', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL), uploads = [];
  await page.route('**/enterprise/api/files/upload', route => {
    uploads.push(route.request().postDataBuffer().toString('utf8'));
    return route.fulfill({ json: { items: Array.from({ length: 8 }, (_, index) => ({ id: `bounded-file-${index}`, name: `fixture-${index}.txt`, size: 1 })), errors: [] } });
  });
  const input = page.locator('.composer-attachment-control input[type="file"]');
  await input.evaluate(node => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'too-large.bin'));
    node.files = transfer.files; node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByRole('alert')).toContainText('exceeds the 25 MiB file limit');
  expect(uploads).toEqual([]);
  await input.setInputFiles(Array.from({ length: 9 }, (_, index) => ({ name: `fixture-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') })));
  await expect(chips(page).getByRole('listitem')).toHaveCount(8);
  expect(uploads).toHaveLength(1);
  expect(uploads[0].match(/name="files";/g)).toHaveLength(8);
  await expect(page.getByRole('alert')).toContainText('fixture-8.txt: up to 8 files per message');
  await trigger(page).click(); await expect(page.getByRole('menuitem', { name: 'Upload photos or files', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await chips(page).getByRole('button', { name: 'Remove fixture-0.txt', exact: true }).click();
  await trigger(page).click(); await expect(page.getByRole('menuitem', { name: 'Upload photos or files', exact: true })).toBeEnabled();
  clean(state);
});
