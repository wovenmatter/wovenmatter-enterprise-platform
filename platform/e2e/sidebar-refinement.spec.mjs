import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { parityFixture, base, project, folder, workspace, org } from './ui-parity.fixture.mjs';

// Browser plugin not available. All requests are isolated by parityFixture.
// Flow: workspace -> preference/rail controls -> native geometry, real motion,
// retained editor/search nodes and focus, including an interrupted transition.
test.use({ storageState: { cookies: [], origins: [] } });
const root = `${base}/workspaces/${project.id}`;
const key = 'wme:sidebar:v1:parity-owner';
const preference = (style, side) => ({ version: 1, style, side, navigationVisible: true, contentVisible: true, singleVisible: true });
const settle = page => page.evaluate(() => Promise.all([...document.querySelectorAll('.sidebar-layout,.sidebar,.sidebar-content-slot,#main')].flatMap(n => n.getAnimations()).map(a => a.finished.catch(() => {}))));
async function setup(page, baseURL, saved) {
  const state = await parityFixture(page, { baseURL });
  state.errors = []; page.on('pageerror', e => state.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') state.errors.push(m.text()); });
  if (saved !== undefined) await page.addInitScript(({ key, saved }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, typeof saved === 'string' ? saved : JSON.stringify(saved)); }, { key, saved });
  await page.route('**/api/me', route => route.fulfill({json:{user:{id:'parity-owner',role:'owner',name:'Synthetic owner',email:'parity@example.test',theme:'green'},organizations:[org],projects:[project]}}));
  await page.route('**/projects/parity-project/databases', route => route.fulfill({json:{databases:[]}}));
  return state;
}
const clean = state => { for (const field of ['errors', 'external', 'unknown', 'writes']) expect(state[field]).toEqual([]); };
async function rect(page, selector) { await settle(page); return page.locator(selector).boundingBox(); }
async function sample(page, action, testInfo, name) {
  const frames = await page.evaluate(async action => {
    const selectors = ['#main', '.sidebar-layout', '.sidebar', '.sidebar-content-slot'];
    const frames = [], start = performance.now();
    const read = () => ({ t: performance.now() - start, scrollLeft: document.querySelector('.shell-body').scrollLeft, titleY: document.querySelector('#main h2')?.getBoundingClientRect().y, boxes: selectors.map(s => { const n = document.querySelector(s), b = n.getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, opacity: Number(getComputedStyle(n).opacity) }; }) });
    frames.push(read()); document.querySelector(action).click();
    while (performance.now() - start < 420) { await new Promise(requestAnimationFrame); frames.push(read()); }
    return frames;
  }, action);
  expect(frames.every(f => f.scrollLeft === 0)).toBe(true);
  await writeFile(testInfo.outputPath(`${name}-frames.json`), JSON.stringify(frames, null, 2));
  return frames;
}
function moved(frames, index, axis = 'x') {
  const values = frames.map(f => f.boxes[index][axis]), first = values[0], last = values.at(-1);
  expect(Math.abs(last - first)).toBeGreaterThan(20);
  expect(values.filter(v => v > Math.min(first,last) + 2 && v < Math.max(first,last) - 2).length).toBeGreaterThanOrEqual(3);
  expect(frames.some(f => f.t >= 180 && f.t <= 260 && Math.abs(f.boxes[index][axis]-last) > .1)).toBe(true);
  expect(frames.filter(f => f.t >= 350).every(f => Math.abs(f.boxes[index][axis]-last) < .1)).toBe(true);
}

for (const style of ['adaptive', 'single', 'split']) for (const side of ['left', 'right']) {
  test(`${style} ${side}: exact 903/904 boundary and 1024/1100 retain requested panels`, async ({ page, baseURL }, info) => {
    const state = await setup(page, baseURL, preference(style, side));
    for (const width of [904, 1024, 1100, 903, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto(workspace); await expect(page.getByLabel('Message your agent')).toBeVisible(); await settle(page);
      const main = await rect(page, '#main');
      expect(await page.locator('.platform-header [data-sidebar-reveal], .platform-header .mobile-menu').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width >= 904) {
        await expect(page.locator('.sidebar')).toBeVisible({ visible: style !== 'single' });
        await expect(page.locator('.workspace-detail-rail')).toBeVisible();
        expect(main.width).toBeGreaterThanOrEqual(360);
        const content = await rect(page, '.sidebar-content-slot'); expect(content.width).toBe(256);
        if (style === 'split' || side === 'right') expect(content.x).toBeGreaterThan(main.x + main.width - 1);
        else expect(content.x + content.width).toBeLessThanOrEqual(main.x);
        if (style === 'adaptive') {
          const nav = await rect(page, '.sidebar');
          expect(Math.abs(nav.x-content.x)).toBe(256);
          expect(nav.x < content.x).toBe(side === 'left');
        }
      } else {
        await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('.workspace-detail-rail')).toBeHidden();
        expect(main.width).toBe(width);
        const opener = page.getByRole('button', { name: style === 'split' ? 'Show workspace sidebar' : 'Show navigation sidebar', exact:true });
        await opener.click(); await settle(page);
        const group = await rect(page, style === 'split' ? '.sidebar-content-slot' : '.sidebar-layout'), shifted = await rect(page, '#main');
        const nativeWidth = Math.min(width*.82,320), pages = style === 'adaptive' && width === 903 ? 2 : 1;
        expect(group.width).toBeCloseTo(nativeWidth*pages, 1);
        expect(Math.abs(shifted.x-main.x)).toBeCloseTo(nativeWidth*pages, 1);
        expect(group.x).toBeGreaterThanOrEqual(-.1); expect(group.x+group.width).toBeLessThanOrEqual(width+.1);
        await expect(page.locator('.workspace-detail-rail')).toBeVisible();
        if (style === 'adaptive' && width === 903) await expect(page.locator('.sidebar')).toBeVisible();
        if (width === 390 && style !== 'split') {
          await page.getByRole('button', { name:'Back to workspace navigation' }).click();
          await expect(page.locator('.sidebar')).toBeVisible();
          await page.locator('.sidebar').getByRole('link', { name:folder.name, exact:true }).click();
          await expect(page.locator('.workspace-detail-rail')).toBeVisible();
        }
        await settle(page);
        await page.screenshot({ path:info.outputPath(`${style}-${side}-${width}-drawer.png`) });
        await page.locator('.mobile-close').click(); await settle(page);
        await expect(opener).toBeFocused();
      }
      await page.screenshot({ path:info.outputPath(`${style}-${side}-${width}.png`) });
    }
    clean(state);
  });
}

test('fresh, missing and invalid preferences display Adaptive; valid explicit choices survive reload', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL);
  await page.goto(root);
  for (const saved of [null, '{invalid', JSON.stringify({ version:1, style:'unknown', side:'right' }), JSON.stringify({ version:99, style:'split' }), ...['single','split','adaptive'].map(style => JSON.stringify(preference(style,'right')))]) {
    await page.evaluate(({key,saved}) => saved === null ? localStorage.removeItem(key) : localStorage.setItem(key,saved), {key,saved});
    await page.reload();
    let expected = 'adaptive'; try { const value = JSON.parse(saved); if (value?.version===1 && ['single','split','adaptive'].includes(value.style)) expected=value.style; } catch {}
    await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-style',expected);
    await page.getByRole('link',{name:'Personal settings',exact:true}).click();
    await expect(page.getByRole('radio',{name:new RegExp(`^${expected[0].toUpperCase()+expected.slice(1)} Sidebar`)})).toBeChecked();
    await page.getByRole('link',{name:'Back to organization',exact:true}).click();
  }
  clean(state);
});

for (const side of ['left','right']) test(`${side}: collapsed reveal stays inside every center surface at native toolbar level`, async ({ page,baseURL },info) => {
  const state=await setup(page,baseURL,{...preference('single',side),singleVisible:false});
  for (const route of ['', '/calendar', '/databases', '/settings']) {
    await page.goto(`${root}${route}?conversation=parity-chat`);
    await expect(page.locator('#main')).toContainText(route==='/settings'?'Settings':route==='/calendar'?'Calendar':route==='/databases'?'Databases':'Retained parity conversation');
    await settle(page);
    const main=await rect(page,'#main'), button=await rect(page,'[data-sidebar-reveal="single"]');
    expect(button.width).toBe(36); expect(button.height).toBe(36);
    expect(button.y-main.y).toBe(12);
    expect(side==='left'?button.x-main.x:main.x+main.width-button.x-button.width).toBe(12);
    expect(await page.locator('.platform-header').evaluate(n=>n.getBoundingClientRect().height)).toBe(41);
    const headings=await page.locator('#main h1,#main h2').evaluateAll(nodes=>nodes.filter(n=>n.checkVisibility()).map(n=>n.getBoundingClientRect().y));
    expect(headings.every(y=>y>=button.y+button.height)).toBe(true);
    await page.screenshot({path:info.outputPath(`collapsed-${side}-${route.slice(1)||'conversation'}.png`)});
    await page.locator('[data-sidebar-reveal="single"]').click(); await settle(page);
    await page.locator('[data-sidebar-hide="navigation"]').click();
    await expect(page.locator('[data-sidebar-reveal="single"]')).toBeFocused();
  }
  clean(state);
});

for (const side of ['left','right']) test(`${side}: sampled hide/reveal, move, expansion/back and compact motion retain nodes and drafts`,async({page,baseURL},info)=>{
  const state=await setup(page,baseURL,preference('adaptive',side)); await page.goto(`${root}?conversation=parity-chat`);
  const draft=page.getByLabel('Message your agent'); await draft.fill('Unsent motion fixture');
  await page.evaluate(()=>{window.sidebarNodes=[document.querySelector('.sidebar'),document.querySelector('.sidebar-content-slot'),document.querySelector('.composer-area textarea')];});
  moved(await sample(page,'[data-folder-selection]',info,'expand'),0,'width');
  await page.getByRole('searchbox',{name:'Search chats'}).fill('Retained');
  moved(await sample(page,'.sidebar-move',info,'move'),1);
  moved(await sample(page,'.sidebar-back',info,'back'),0,'width');
  const hide = await sample(page,'[data-sidebar-hide="navigation"]',info,'hide');
  moved(hide,0,'width');
  expect(hide.filter(f=>f.titleY>hide[0].titleY+2&&f.titleY<hide.at(-1).titleY-2).length).toBeGreaterThanOrEqual(3);
  await page.screenshot({path:info.outputPath('collapsed-moved-desktop.png')});
  moved(await sample(page,'[data-sidebar-reveal="single"]',info,'reveal'),0,'width');
  await page.locator('[data-folder-selection]').first().click(); await settle(page);
  await expect(page.getByRole('searchbox',{name:'Search chats'})).toHaveValue('Retained');
  await expect(draft).toHaveValue('Unsent motion fixture');
  await page.setViewportSize({width:903,height:900}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true'); await settle(page);
  moved(await sample(page,'[data-sidebar-reveal="single"]',info,'compact-open'),0);
  moved(await sample(page,'.mobile-close',info,'compact-close'),0);
  await page.setViewportSize({width:390,height:844}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true'); await settle(page);
  moved(await sample(page,'[data-sidebar-reveal="single"]',info,'phone-open'),0);
  moved(await sample(page,'.mobile-close',info,'phone-close'),0);
  expect(await page.evaluate(()=>window.sidebarNodes.every(n=>n.isConnected)&&window.sidebarNodes[2]===document.querySelector('.composer-area textarea'))).toBe(true);
  await expect(draft).toHaveValue('Unsent motion fixture'); clean(state);
});

test('rapid interruptions continue from rendered geometry; reduced motion makes immediate final changes',async({page,baseURL},info)=>{
  const state=await setup(page,baseURL,preference('adaptive','left')); await page.goto(workspace); await expect(page.getByLabel('Message your agent')).toBeVisible(); await settle(page);
  await page.getByRole('searchbox',{name:'Search chats'}).fill('Retained');
  const rapid=await page.evaluate(async()=>{
    const frames=[], start=performance.now(), rail=document.querySelector('.sidebar-layout');
    for(let i=0;i<5;i++) {
      const before=rail.getBoundingClientRect().x, beforeAt=performance.now(); document.querySelector('.sidebar-move').click();
      await new Promise(requestAnimationFrame); const after=rail.getBoundingClientRect().x;
      frames.push({t:performance.now()-start,dt:performance.now()-beforeAt,before,after,endpoint:i%2===0?innerWidth-520:8,span:innerWidth-528});
      await new Promise(r=>setTimeout(r,55));
    }
    return frames;
  });
  await writeFile(info.outputPath('rapid-frames.json'),JSON.stringify(rapid,null,2));
  // A 300ms cubic-bezier(.2,.8,.2,1) has maximum initial slope4.
  // Bound displacement by elapsed frame time, and reject a direct endpoint snap.
  expect(rapid.every(f=>Math.abs(f.after-f.before)<=f.span*4*f.dt/300+3)).toBe(true);
  expect(rapid.filter(f=>f.dt<60).every(f=>Math.abs(f.after-f.endpoint)>2)).toBe(true);
  await settle(page); await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-side','right');
  await expect(page.getByRole('searchbox',{name:'Search chats'})).toHaveValue('Retained');
  await page.emulateMedia({reducedMotion:'reduce'});
  const frames=await sample(page,'.sidebar-move',info,'reduced-motion');
  expect(frames.slice(1).every(f=>Math.abs(f.boxes[1].x-8)<.1)).toBe(true);
  expect(await page.locator('.sidebar-layout').evaluate(n=>n.getAnimations().length)).toBe(0);
  await page.setViewportSize({width:390,height:844}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true'); await settle(page);
  const compact=await sample(page,'[data-sidebar-reveal="single"]',info,'reduced-compact');
  expect(compact.slice(1).every(f=>Math.abs(f.boxes[0].x-319.8)<.1)).toBe(true);
  clean(state);
});

test('Split controls stay on both center edges; compact content enters and exits only the right edge',async({page,baseURL},info)=>{
  const state=await setup(page,baseURL,{...preference('split','left'),navigationVisible:false,contentVisible:false});
  await page.goto(workspace); await expect(page.getByLabel('Message your agent')).toBeVisible();
  const controls=page.locator('#main [data-sidebar-reveal]'); await expect(controls).toHaveCount(2);
  const main=await rect(page,'#main'), left=await rect(page,'[data-sidebar-reveal="navigation"]'), right=await rect(page,'[data-sidebar-reveal="content"]');
  expect(left.x-main.x).toBe(12); expect(main.x+main.width-right.x-right.width).toBe(12);
  await page.screenshot({path:info.outputPath('split-both-hidden.png')});
  await page.reload(); await expect(controls).toHaveCount(2);
  for (const width of [903,390]) {
    await page.setViewportSize({width,height:900}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true'); await settle(page);
    const frames=await sample(page,'[data-sidebar-reveal="content"]',info,`split-right-${width}-open`);
    moved(frames,3); expect(frames.every(f=>f.boxes[3].x>=width-Math.min(width*.82,320)-.1)).toBe(true);
    expect(frames.every(f=>Math.abs(f.boxes[3].y-frames[0].boxes[3].y)<.1)).toBe(true);
    const close=await sample(page,'.mobile-close',info,`split-right-${width}-close`);
    moved(close,3); expect(close.every(f=>f.boxes[3].x>=width-Math.min(width*.82,320)-.1)).toBe(true);
    expect(close.every(f=>Math.abs(f.boxes[3].y-close[0].boxes[3].y)<.1)).toBe(true);
    await expect(page.locator('[data-sidebar-reveal="content"]')).toBeFocused();
  }
  clean(state);
});

test('unsaved note, textarea selection/focus and scroll survive moving, collapse, reveal and compact paging',async({page,baseURL},info)=>{
  const state=await setup(page,baseURL,preference('adaptive','left'));
  const note={id:'motion-note',projectId:project.id,kind:'note',title:'Motion note',body:'Retained synthetic note\n'.repeat(60),folderId:folder.id,data:{format:'markdown'},revision:1};
  await page.route('**/workspace-content/motion-note',route=>route.fulfill({json:note}));
  await page.goto(`${workspace}&note=motion-note`);
  const editor=page.getByRole('textbox',{name:'Document body',exact:true});
  await editor.fill('Unsent synthetic note\n'.repeat(60));
  await editor.evaluate(n=>{window.noteNode=n;n.setSelectionRange(6,16);n.scrollTop=100;n.focus({preventScroll:true});window.noteScroll=n.scrollTop;});
  await sample(page,'.sidebar-move',info,'note-move');
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(n=>n===window.noteNode&&n.selectionStart===6&&n.selectionEnd===16&&n.scrollTop===window.noteScroll)).toBe(true);
  await sample(page,'[data-sidebar-hide="content"]',info,'note-hide');
  await sample(page,'[data-sidebar-reveal="single"]',info,'note-reveal');
  await page.setViewportSize({width:390,height:844}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true');
  await page.locator('[data-sidebar-reveal="single"]').click();
  await page.getByRole('button',{name:'Back to workspace navigation'}).click();
  await page.locator('.sidebar').getByRole('link',{name:folder.name,exact:true}).click();
  await page.locator('.mobile-close').click(); await settle(page);
  await expect(editor).toHaveValue('Unsent synthetic note\n'.repeat(60));
  expect(await editor.evaluate(n=>n===window.noteNode&&n.selectionStart===6&&n.selectionEnd===16)).toBe(true);
  await page.screenshot({path:info.outputPath('retained-mobile-note.png')}); clean(state);
});
