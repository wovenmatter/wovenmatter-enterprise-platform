import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { parityFixture, project, base } from './ui-parity.fixture.mjs';

// Browser plugin not available. All records, writes and responses are synthetic;
// the shared fixture blocks external requests and unexpected mutations.
test.use({ storageState: { cookies: [], origins: [] }, timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1440, height: 1100 } });
const path = `${base}/workspaces/${project.id}`;
const evidence = process.env.WME_CALENDAR_EVIDENCE ?? '/tmp/wme-calendar-evidence';
const record = (id, title, kind, day, data = {}) => ({
  id, title, kind, projectId: project.id, folderId: null, body: '', revision: 4,
  createdBy: 'parity-owner', updatedBy: 'parity-owner', createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-22T09:00:00Z',
  data: { startsAt: `2026-10-${day}T09:00:00Z`, timeZone: 'UTC', color: kind === 'task' ? '#4169e1' : '#004225',
    ...(kind === 'task' ? { enabled: true, showsOnCalendar: true, prompt: 'Synthetic scheduled work', harness: 'pi', sessionMode: 'same' } : {}), ...data },
});
async function setup(page, baseURL, theme = 'green') {
  await page.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
  const state = await parityFixture(page, { baseURL, theme });
  state.records = [
    record('event', 'Planning review', 'event', '23'),
    record('task', 'Research run', 'task', '23'),
    record('recurring-event', 'Weekly planning', 'event', '16', { recurrence: { unit: 'week', interval: 1 } }),
    record('recurring-task', 'Daily summary', 'task', '22', { recurrence: { unit: 'day', interval: 1 } }),
    record('overflow', 'Overflow review', 'event', '23', { startsAt: '2026-10-23T13:00:00Z' }),
    record('hidden-task', 'Hidden scheduled task', 'task', '23', { showsOnCalendar: false }),
  ];
  state.mutations = []; state.errors = [];
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) state.errors.push(message.text()); });
  await page.route('**/enterprise/api/projects/parity-project/workspace-content**', async route => {
    const request = route.request(), url = new URL(request.url());
    const suffix = url.pathname.split('/workspace-content')[1];
    if (request.method() === 'GET') {
      if (suffix.endsWith('/runs')) return route.fulfill({ json: { items: [], state: { nextAt: '2026-10-24T09:00:00Z', lastStatus: 'pending' } } });
      return route.fulfill({ json: { items: state.records } });
    }
    const data = request.postDataJSON();
    state.mutations.push({ path: url.pathname, method: request.method(), data });
    const item = state.records.find(item => `/${item.id}` === suffix);
    if (request.method() === 'PATCH' && item && data.expectedRevision === item.revision) {
      Object.assign(item, data, { revision: item.revision + 1 });
      return route.fulfill({ json: item });
    }
    return route.fulfill({ status: 403, json: { error: { message: 'Synthetic fixture forbids this mutation' } } });
  });
  return state;
}

for (const theme of ['green', 'cognac', 'dark']) test(`${theme}: calendar shows desktop month, selected day, legend and category markers`, async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, theme);
  await page.goto(`${path}/calendar`);
  await expect(page).toHaveURL(`${baseURL}${path}/calendar`);
  await expect(page).toHaveTitle('WovenMatter Enterprise Platform');
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
  await expect(page.locator('.calendar-header').getByRole('button', { name: 'Add event', exact: true })).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.getByRole('gridcell')).toHaveCount(42);
  await expect(page.getByRole('columnheader')).toHaveCount(7);
  const selected = page.getByRole('gridcell', { selected: true });
  await expect(selected).toHaveAttribute('aria-label', 'Friday, October 23, 2026, 5 events');
  await expect(selected.locator('.calendar-occurrence')).toHaveCount(3);
  await expect(selected.getByRole('button', { name: /Show all 5 events/ })).toHaveText('+2 more');
  await expect(page.locator('.calendar-agenda .agenda-row')).toHaveCount(5);
  await expect(page.getByText('Hidden scheduled task', { exact: true })).toHaveCount(0);
  const boxes = await page.locator('.calendar-month,.calendar-agenda,.calendar-legend').evaluateAll(nodes => nodes.map(node => {
    const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
  }));
  expect(boxes[0].y + boxes[0].height).toBeLessThan(boxes[1].y);
  expect(boxes[1].y + boxes[1].height).toBeLessThan(boxes[2].y);
  expect(boxes[0].width).toBeLessThanOrEqual(1080);
  const arrow = page.getByRole('button', { name: 'Previous month' }).locator('svg');
  await expect(arrow).toHaveClass(/lucide-arrow-left/); await expect(arrow).toHaveAttribute('stroke-width', '1.75'); await expect(arrow).toHaveAttribute('width', '14');
  const expected = theme === 'dark' ? ['rgb(139, 188, 158)', 'rgb(145, 167, 239)', 'rgb(181, 165, 220)', 'rgb(215, 164, 119)'] : ['rgb(0, 66, 37)', 'rgb(65, 105, 225)', 'rgb(116, 98, 166)', 'rgb(154, 90, 42)'];
  for (const [index, title] of ['Planning review', 'Research run', 'Weekly planning', 'Daily summary'].entries()) {
    const color = await page.locator('.agenda-title').filter({ hasText: title }).locator('.event-color').evaluate(node => getComputedStyle(node).backgroundColor);
    expect(color).toBe(expected[index]);
  }
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${theme}-calendar-desktop.png` });
  await page.locator('.calendar-legend').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/${theme}-calendar-desktop-agenda.png` });
  await selected.getByRole('button', { name: /Show all 5 events/ }).click();
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Weekly planning, Reoccurring Events', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Edit event' })).toBeVisible();
  await expect(page.getByLabel('Starts', { exact: true })).toHaveValue('2026-10-16T09:00');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('gridcell')).toHaveCount(42);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const palette = page.getByRole('button', { name: 'Events color: British Racing Green', exact: true });
  await palette.click();
  await expect(page.getByRole('option', { selected: true })).toHaveText('British Racing Green');
  await expect(page.getByRole('listbox')).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: `${evidence}/${theme}-calendar-mobile-palette.png` });
  await page.keyboard.press('Escape'); await expect(palette).toBeFocused();
  expect(state.errors).toEqual([]); expect(state.mutations).toEqual([]); expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
});

test('month navigation, adjacent days and keyboard date movement keep the selected-day list in sync', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL); await page.goto(`${path}/calendar`);
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.locator('.calendar-month-heading h2')).toHaveText('November 2026');
  await expect(page.locator('.calendar-agenda-heading h2')).toHaveText('Sunday, November 1');
  await page.getByRole('button', { name: 'Sunday, December 6, 2026', exact: true }).click();
  await expect(page.locator('.calendar-month-heading h2')).toHaveText('December 2026');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('.calendar-agenda-heading h2')).toHaveText('Friday, October 23');
  await page.getByRole('button', { name: 'Friday, October 23, 2026', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Saturday, October 24, 2026', exact: true })).toBeFocused();
  await expect(page.locator('.calendar-agenda-heading h2')).toHaveText('Saturday, October 24');
  await expect(page.locator('.calendar-agenda .agenda-row')).toHaveCount(1);
  expect(state.errors).toEqual([]); expect(state.mutations).toEqual([]); expect(state.external).toEqual([]);
});

test('category colors persist locally while task enable and history preserve workspace records', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL); await page.goto(`${path}/calendar`);
  const palette = page.getByRole('button', { name: 'Events color: British Racing Green', exact: true });
  await palette.click(); await page.getByRole('option', { name: 'Pink', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Events color: Pink', exact: true })).toBeFocused();
  await expect(page.locator('.agenda-title').filter({ hasText: 'Planning review' }).locator('.event-color')).toHaveCSS('background-color', 'rgb(215, 90, 149)');
  await page.reload(); await expect(page.getByRole('button', { name: 'Events color: Pink', exact: true })).toBeVisible();
  expect(state.mutations).toEqual([]);
  const task = state.records.find(item => item.id === 'task'); const original = structuredClone(task.data);
  await page.getByRole('switch', { name: 'Enable Research run', exact: true }).uncheck();
  await expect.poll(() => state.mutations.length).toBe(1);
  expect(state.mutations[0]).toMatchObject({ method: 'PATCH', path: '/enterprise/api/projects/parity-project/workspace-content/task', data: { expectedRevision: 4, data: { ...original, enabled: false } } });
  await page.locator('.calendar-agenda > div').filter({ has: page.getByRole('button', { name: /^Research run,/ }) }).getByText('Run history', { exact: true }).click();
  await expect(page.getByText('No runs yet.', { exact: true })).toBeVisible();
  await page.goto(`${path}/tasks`);
  await expect(page.getByRole('button', { name: /^Hidden scheduled task,/ })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Enable Research run', exact: true })).not.toBeChecked();
  expect(state.errors).toEqual([]); expect(state.writes).toEqual([]); expect(state.external).toEqual([]); expect(state.unknown).toEqual([]);
});
