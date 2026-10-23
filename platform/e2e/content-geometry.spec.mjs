import { test, expect } from '@playwright/test';
import { parityFixture, base, workspace, project } from './ui-parity.fixture.mjs';

test.use({ storageState: { cookies: [], origins: [] } });

test('compact header keeps item sizes and content below wrapped rows', async ({ page, baseURL }) => {
  await parityFixture(page, { baseURL });
  await page.goto(workspace);
  await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible();
  for (const width of [1536, 900, 761, 760, 390]) {
    await page.setViewportSize({ width, height: 860 });
    const geometry = await page.evaluate(() => {
      const header = document.querySelector('.platform-header');
      const box = element => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom }; };
      return { header: box(header), image: box(header.querySelector('.brand img')), type: getComputedStyle(header.querySelector('.brand')).fontSize,
        items: [...header.querySelectorAll('a, button')].map(box), main: box(document.querySelector('main')), width: document.documentElement.scrollWidth };
    });
    expect(geometry.image.width).toBe(24);
    expect(geometry.image.height).toBe(24);
    expect(geometry.type).toBe('13px');
    if (width >= 1320) expect(geometry.header.height).toBeLessThanOrEqual(45);
    expect(geometry.main.top).toBeGreaterThanOrEqual(geometry.header.bottom);
    expect(geometry.width).toBeLessThanOrEqual(width);
    for (const item of geometry.items.filter(item => item.height)) {
      expect(item.top).toBeGreaterThanOrEqual(0);
      expect(item.bottom).toBeLessThanOrEqual(geometry.header.bottom);
    }
  }
});

test('Databases empty state centers in its pane and populated query stays inside it', async ({ page, baseURL }, testInfo) => {
  const state = await parityFixture(page, { baseURL });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let databases = [];
  await page.route('**/enterprise/api/projects/*/databases', route => {
    const request = route.request().postDataJSON();
    if (request.action === 'create') {
      const database = { id: 'geometry-db', name: request.name, revision: 1 };
      databases = [database];
      return route.fulfill({ json: database });
    }
    if (request.action === 'query') return route.fulfill({ json: { query: { columns: ['name', 'type'], rows: [['Synthetic records', 'table']] } } });
    return route.fulfill({ json: { databases } });
  });
  await page.goto(`${base}/workspaces/${project.id}/databases`);
  const panel = page.locator('.database-page');
  await expect(panel.getByRole('heading', { name: 'Databases', exact: true })).toBeVisible();
  for (const width of [1536, 1320, 900, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await expect(panel.getByRole('heading', { name: 'No database selected' })).toBeVisible();
    const geometry = await panel.evaluate(element => {
      const pane = element.getBoundingClientRect(), empty = element.querySelector('.empty').getBoundingClientRect();
      return { delta: Math.abs(pane.x + pane.width / 2 - empty.x - empty.width / 2), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.delta).toBeLessThanOrEqual(1);
    expect(geometry.overflow).toBe(false);
  }
  await panel.getByRole('button', { name: 'Create database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New database' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Synthetic records');
  await dialog.getByRole('button', { name: 'Create database', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await panel.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(panel.getByRole('cell', { name: 'Synthetic records', exact: true })).toBeVisible();
  for (const width of [1536, 1320, 900, 390]) {
    await page.setViewportSize({ width, height: 860 });
    const geometry = await panel.evaluate(element => {
      const pane = element.getBoundingClientRect(), work = element.querySelector('.database-workbench').getBoundingClientRect();
      return { left: work.left >= pane.left, right: work.right <= pane.right, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry).toEqual({ left: true, right: true, overflow: false });
    await page.screenshot({ path: testInfo.outputPath(`database-query-${width}.png`) });
  }
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(state.external).toEqual([]);
});
