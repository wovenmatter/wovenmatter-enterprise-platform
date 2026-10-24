import { test, expect } from '@playwright/test';
import { parityFixture, org, project, folder, base, workspace } from './ui-parity.fixture.mjs';

test.use({ storageState: { cookies: [], origins: [] } });

async function setup(page, baseURL, { role = 'owner', orgRole = 'member', count = 1 } = {}) {
  const state = await parityFixture(page, { baseURL });
  const user = role === 'anonymous' ? null : { id: 'parity-owner', role, name: 'Synthetic colleague', email: 'synthetic@example.test', theme: 'green' };
  const organizations = Array.from({ length: count }, (_, index) => ({ ...org, id: index ? `other-${index}` : org.id, name: index ? `Organization ${index + 1}` : org.name, role: orgRole }));
  state.errors = []; state.apiRequests = [];
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.errors.push(message.text()); });
  await page.route('**/enterprise/api/**', route => {
    const path = new URL(route.request().url()).pathname.slice('/enterprise/api'.length);
    state.apiRequests.push({path, method:route.request().method()});
    if (path === '/session') return route.fulfill({ json: { user, csrfToken: 'synthetic' } });
    if (path === '/organizations') return route.fulfill({ json: { items: organizations } });
    if (path === '/me') return route.fulfill({ json: { user, organizations, projects: [] } });
    if (path === '/accounts') return route.fulfill({ json: { items: [] } });
    if (path === '/platform/settings') return route.fulfill({ json: { owner: user, organizations: count, accounts: 1, hosts: [] } });
    return route.fallback();
  });
  return state;
}

async function header(page, { owner = false, anonymous = false } = {}) {
  const top = page.locator('.platform-header');
  await expect(top).toHaveCount(1); await expect(top).toBeVisible();
  await expect(top.getByRole('link', { name: 'WovenMatter Enterprise Platform', exact: true })).toBeVisible();
  await expect(top.getByRole('link', { name: 'WovenMatter Enterprise Platform', exact: true })).toHaveAttribute('href', await top.getByRole('link', { name: 'Organization', exact: true }).getAttribute('href'));
  await expect(page.locator('a a')).toHaveCount(0);
  await expect(top.locator('nav > a, nav > button')).toHaveText([
    ...(owner ? ['Admin'] : []), 'Organization', 'Settings', anonymous ? 'Sign in' : 'Sign out',
  ]);
  await expect(top.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', /\/enterprise\/personal-settings(?:\?|$)/);
  await expect(top.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(owner ? 1 : 0);
  await expect(top.getByRole('button', { name: 'Open navigation', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar a[href*="personal-settings"], .sidebar-footer')).toHaveCount(0);
  await expect(page.locator('.sidebar').getByRole('link', { name: /^(Administration|Back to organization|Your organizations)$/ })).toHaveCount(0);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page).toHaveTitle(/WovenMatter/);
}

for (const scenario of [
  { name: 'owner', role: 'owner', orgRole: 'admin', count: 1 },
  { name: 'multi-organization owner', role: 'owner', orgRole: 'admin', count: 2 },
  { name: 'organization admin', role: 'member', orgRole: 'admin', count: 1 },
  { name: 'member', role: 'member', orgRole: 'member', count: 1 },
  { name: 'multi-organization member', role: 'member', orgRole: 'member', count: 2 },
]) test(`${scenario.name}: shared navigation and workspace settings round-trip`, async ({ page, baseURL }, testInfo) => {
  const state = await setup(page, baseURL, scenario);
  const owner = scenario.role === 'owner';
  const check = () => header(page, { owner, count: scenario.count });
  const root = owner || scenario.count > 1 ? '/enterprise/' : `${base}/workspaces`;
  await page.goto('/enterprise/');
  await expect(page).toHaveURL(new URL(root, baseURL).href);
  await check();
  if (owner) for (const [label, path] of [['Organizations','/organizations'], ['Accounts','/accounts'], ['Platform settings','/platform-settings']]) {
    await expect(page.getByRole('heading', { name:'Admin', exact:true })).toBeVisible();
    await expect(page.locator('main table')).toHaveCount(0);
    await page.getByRole('navigation', { name:'Administration', exact:true }).getByRole('link', { name:label, exact:true }).click();
    await expect(page).toHaveURL(new URL(`/enterprise${path}`, baseURL).href);
    await check(); await expect(page.getByRole('heading', { name:label, exact:true })).toBeVisible();
    await page.getByRole('link', { name:'Back to Admin', exact:true }).click(); await check();
  }
  if (!owner) for (const path of ['/enterprise/accounts', '/enterprise/platform-settings']) {
    await page.goto(path); await expect(page).toHaveURL(url => url.pathname.replace(/\/$/, "") === root.replace(/\/$/, "")); await check();
  }
  await page.locator('.platform-header').getByRole('link', { name:'WovenMatter Enterprise Platform', exact:true }).click();
  await expect(page).toHaveURL(new URL(scenario.count === 1 ? `${base}/workspaces` : '/enterprise/organizations', baseURL).href);
  await page.goto(`${base}/workspaces`); await check();
  const orgNav = page.getByRole('navigation', { name: 'Organization navigation' });
  await expect(orgNav.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(owner || scenario.orgRole === 'admin' ? 1 : 0);
  await page.goto(workspace); await check();
  await page.locator('.platform-header').getByRole('link', { name: 'WovenMatter Enterprise Platform', exact: true }).click();
  await expect(page).toHaveURL(new URL(`${base}/workspaces`, baseURL).href);
  await page.goto(workspace); await check();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace.png`) });
  const settings = page.locator('.platform-header').getByRole('link', { name: 'Settings', exact: true });
  await settings.click(); await expect(page.getByRole('heading', { name: 'Personal settings', exact: true })).toBeVisible(); await check();
  const expectedReturn = workspace.replace('/enterprise', '');
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(expectedReturn);
  await settings.click(); // Clicking the global link again must not discard context.
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(expectedReturn);
  await page.getByRole('link', { name: 'Back to organization', exact: true }).click();
  await expect(page).toHaveURL(new URL(workspace, baseURL).href);
  await expect(page.getByRole('heading', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

for (const role of ['owner', 'member']) test(`${role}: mobile header, drawer and composer fit remaining viewport`, async ({ page, baseURL }, testInfo) => {
  const state = await setup(page, baseURL, { role, count: 2 });
  await page.goto(workspace);
  for (const width of [320, 390, 760, 761, 1320]) {
    await page.setViewportSize({ width, height: 844 });
    await header(page, { owner: role === 'owner', count: 2 });
    await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible();
    const geometry = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      return { header: rect('.platform-header'), main: rect('main'), composer: rect('.composer-area'), width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
    });
    expect(geometry.width).toBeLessThanOrEqual(width);
    expect(geometry.height).toBeLessThanOrEqual(844);
    expect(geometry.main.top).toBeGreaterThanOrEqual(geometry.header.bottom);
    expect(geometry.composer.bottom).toBeLessThanOrEqual(844);
    expect(geometry.composer.top).toBeGreaterThan(geometry.header.bottom);
    if (width === 390) {
      const centers = await page.locator('.platform-header nav > *').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return r.top + r.height / 2; }));
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    }
    if (width < 640) {
      await page.getByRole('button', { name: 'Show navigation sidebar', exact: true }).click();
      if (await page.getByRole('button', { name: 'Back to workspace navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back to workspace navigation', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
      await expect(drawer).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${role}-drawer-top-${width}.png`), animations: 'disabled' });
      await expect(page.locator('.platform-header')).toHaveAttribute('inert', '');
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      await expect(drawer.locator('a[href*="personal-settings"]')).toHaveCount(0);
      const recents = drawer.locator('.sidebar summary').filter({ hasText: /^Recents$/ });
      await recents.click(); // A collapsed final section is still part of keyboard navigation.
      const close = drawer.getByRole('button', { name: 'Hide navigation sidebar', exact: true });
      await close.focus(); await page.keyboard.press('Shift+Tab');
      await expect(recents).toBeFocused();
      await page.keyboard.press('Tab'); await expect(close).toBeFocused();
      await recents.click();
      await page.screenshot({ path: testInfo.outputPath(`${role}-drawer-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Show navigation sidebar', exact: true })).toBeFocused();
      await expect(page.locator('.platform-header')).not.toHaveAttribute('inert');
    }
    await page.screenshot({ path: testInfo.outputPath(`${role}-workspace-${width}.png`), animations: 'disabled' });
  }
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('Agents and Folders are independent sections with working folder navigation', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  await page.goto(workspace);
  const rail = page.locator('.workspace-navigation');
  await expect(rail.locator(':scope > details > summary')).toHaveText(['Agents', 'Folders', 'Recents']);
  await expect(rail.locator('summary').filter({ hasText: project.name })).toHaveCount(0);
  await expect(rail.locator('.workspace-rail-title')).toHaveText(project.name);
  await rail.locator('summary').filter({ hasText: /^Agents$/ }).click();
  await expect(rail.getByRole('link', { name: 'Pi Durable', exact: true })).toBeHidden();
  await expect(rail.getByRole('link', { name: folder.name, exact: true })).toBeVisible();
  await rail.locator('summary').filter({ hasText: /^Agents$/ }).click();
  await rail.locator('summary').filter({ hasText: /^Folders$/ }).click();
  await expect(rail.getByRole('link', { name: folder.name, exact: true })).toBeHidden();
  await expect(rail.getByRole('link', { name: 'Pi Durable', exact: true })).toBeVisible();
  await rail.locator('summary').filter({ hasText: /^Folders$/ }).click();
  await rail.getByRole('link', { name: folder.name, exact: true }).click();
  await expect(page).toHaveURL(new URL(`${base}/workspaces/${project.id}?folder=${folder.id}&conversation=parity-chat`, baseURL).href);
  await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible();
  await rail.getByRole('link', { name: folder.name, exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

test('logout failure remains visible in the shared header and retry signs out', async ({ page, baseURL }) => {
  await setup(page, baseURL);
  let fail = true;
  await page.route('**/enterprise/api/logout', route => route.fulfill(fail
    ? { status: 503, json: { error: { message: 'Synthetic logout unavailable' } } }
    : { json: { ok: true } }));
  await page.goto(workspace);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('.platform-header').getByRole('alert')).toHaveText('Synthetic logout unavailable');
  fail = false;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
  await header(page, { anonymous: true });
});

test('right-panel Chats and Notes search retain All Workspaces and folder scope', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  const chats = [
    { id: 'parity-chat', title: 'Retained parity conversation', folderId: folder.id, harness: 'pi' },
    { id: 'other-chat', title: 'Other conversation', folderId: null, harness: 'pi' },
  ];
  const notes = [
    { id: 'folder-note', title: 'Folder research', folderId: folder.id, kind: 'note', data: {} },
    { id: 'other-note', title: 'Other research', folderId: null, kind: 'note', data: {} },
  ];
  await page.route('**/enterprise/api/projects/*/conversations', route => route.fulfill({ json: { items: chats } }));
  await page.route('**/enterprise/api/projects/*/workspace-content?kind=note', route => route.fulfill({ json: { items: notes } }));
  await page.goto(workspace);
  const content = page.getByRole('complementary', { name: 'Workspace content' });
  const rail = page.locator('.workspace-navigation');
  await expect(rail.getByRole('searchbox')).toHaveCount(0);
  await expect(content.getByRole('link', { name: 'Other conversation', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('no match');
  await expect(content.locator('.workspace-detail-list').getByRole('link')).toHaveCount(0);
  await expect(rail.getByRole('link', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('retained');
  await expect(content.getByRole('link', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('');
  await rail.getByRole('link', { name: folder.name, exact: true }).click();
  await expect(content.getByRole('link', { name: 'Other conversation', exact: true })).toHaveCount(0);
  await expect(content.getByRole('link', { name: 'Retained parity conversation', exact: true })).toBeVisible();
  await content.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(content.getByRole('link', { name: 'Folder research', exact: true })).toBeVisible();
  await expect(content.getByRole('link', { name: 'Other research', exact: true })).toHaveCount(0);
  await content.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('other');
  await expect(content.getByRole('link', { name: 'Folder research', exact: true })).toHaveCount(0);
  await rail.getByRole('link', { name: 'All Workspaces', exact: true }).click();
  await expect(content.getByRole('link', { name: 'Other research', exact: true })).toBeVisible();
  await content.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('');
  await expect(content.getByRole('link', { name: 'Folder research', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]);
});

for (const role of ['owner', 'member']) test(`${role}: no organization and invalid settings return keep the same header`, async ({ page, baseURL }) => {
  const state = await setup(page, baseURL, { role, count: 0 });
  for (const returnTo of ['', '/organizations/revoked/workspaces', '//example.invalid/organizations/parity-org/workspaces', '/accounts']) {
    await page.goto(`/enterprise/personal-settings?returnTo=${encodeURIComponent(returnTo)}`);
    await expect(page.getByRole('heading', { name:'Personal settings', exact:true })).toBeVisible();
    await header(page, { owner:role === 'owner' });
    await expect(page.locator('.platform-header').getByRole('link', { name:'Organization', exact:true })).toHaveAttribute('href', '/enterprise/organizations');
  }
  await page.locator('.platform-header').getByRole('link', { name:'Organization', exact:true }).click();
  await expect(page.getByRole('heading', { name:role === 'owner' ? 'Organizations' : 'Your organizations', exact:true })).toBeVisible();
  await header(page, { owner:role === 'owner' });
  if (role === 'member') await expect(page.getByRole('button', { name:'Create organization', exact:true })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]); expect(state.writes).toEqual([]);
});

for (const role of ['owner', 'member']) test(`${role}: multiple organizations switch through page content with keyboard`, async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL, { role, count:2 });
  await page.goto(workspace);
  const top = page.locator('.platform-header');
  await top.getByRole('link', { name:'Settings', exact:true }).click();
  await expect(top.getByRole('link', { name:'Organization', exact:true })).toHaveAttribute('href', `${base}/workspaces`);
  await top.getByRole('link', { name:'WovenMatter Enterprise Platform', exact:true }).click();
  const switcher = page.locator('main').getByRole('link', { name:'Switch organization', exact:true });
  await switcher.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new URL('/enterprise/organizations', baseURL).href);
  await header(page, { owner:role === 'owner' });
  await expect(page.locator('main tbody tr')).toHaveCount(2);
  await expect(page.getByRole('button', { name:'Create organization', exact:true })).toHaveCount(role === 'owner' ? 1 : 0);
  const destination = page.getByRole('link', { name:'Organization 2', exact:true });
  await destination.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new URL('/enterprise/organizations/other-1/workspaces', baseURL).href);
  await expect(top.getByRole('link', { name:'Organization', exact:true })).toHaveAttribute('href', '/enterprise/organizations/other-1/workspaces');
  await expect(page.locator('.org-title')).toContainText('Organization 2');
  await switcher.click(); await page.getByRole('link', { name:org.name, exact:true }).click();
  await expect(page).toHaveURL(new URL(`${base}/workspaces`, baseURL).href);
  await page.screenshot({ path:info.outputPath(`${role}-organization-switch.png`) });
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]); expect(state.writes).toEqual([]); expect(state.unknown).toEqual([]);
});

for (const width of [320,390,1320]) test(`anonymous ${width}: fixed header on sign-in and protected gates without authentication`, async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL, { role:'anonymous', count:0 });
  await page.setViewportSize({width,height:844});
  for (const path of ['/login','/','/organizations','/accounts','/platform-settings','/personal-settings',`${base.replace('/enterprise','')}/workspaces`, '/activate', '/forgot-password', '/reset-password']) {
    await page.goto(`/enterprise${path}`);
    await header(page, {anonymous:true});
    await expect(page.locator('.auth-panel h1')).toBeVisible();
    await expect(page.locator('.platform-header nav > *').last()).toHaveText('Sign in');
    await expect(page.locator('.sidebar, .platform-page, .workspace-page')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  const top = page.locator('.platform-header');
  for (const [label,path] of [['WovenMatter Enterprise Platform','/organizations'],['Organization','/organizations'],['Settings','/personal-settings'],['Sign in','/login']]) {
    await top.getByRole('link', {name:label,exact:true}).click();
    await expect(page).toHaveURL(new URL(`/enterprise${path}`,baseURL).href);
    await expect(page.getByRole('heading',{name:'Welcome back',exact:true})).toBeVisible();
    await header(page,{anonymous:true});
  }
  await page.screenshot({path:info.outputPath(`anonymous-login-${width}.png`)});
  expect(state.apiRequests.every(r=>r.path==='/session' && r.method==='GET')).toBe(true);
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]); expect(state.writes).toEqual([]);
});

for (const width of [320,390,1320]) test(`owner ${width}: global header geometry stays fixed across all page types`, async ({page,baseURL},info)=>{
  const state=await setup(page,baseURL,{count:2}); await page.setViewportSize({width,height:844});
  let expected;
  for (const [label,path] of [['admin','/'],['organizations','/organizations'],['accounts','/accounts'],['platform-settings','/platform-settings'],['organization',`${base.replace('/enterprise','')}/workspaces`],['workspace',workspace.replace('/enterprise','')],['settings','/personal-settings'],['auth','/forgot-password']]) {
    await page.goto(`/enterprise${path}`); await header(page,{owner:true});
    if (label==='workspace') await expect(page.getByRole('textbox',{name:'Message your agent',exact:true})).toBeVisible();
    else await expect(page.locator('main h1')).toBeVisible();
    const geometry=await page.locator('.platform-header').evaluate(el=>({height:el.getBoundingClientRect().height,items:[...el.querySelectorAll('nav > *')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y+r.height/2];})}));
    if (!expected) expected=geometry; else expect(geometry).toEqual(expected);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (label==='organization' && width<640) {
      const opener=page.getByRole('button',{name:'Open navigation',exact:true}); await opener.click();
      await expect(page.getByRole('dialog',{name:'Navigation',exact:true})).toBeVisible();
      await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
    }
    if (['admin','organizations','workspace'].includes(label)) await page.screenshot({path:info.outputPath(`${label}-${width}.png`),animations:'disabled'});
  }
  expect(state.errors).toEqual([]); expect(state.external).toEqual([]); expect(state.writes).toEqual([]); expect(state.unknown).toEqual([]);
});
