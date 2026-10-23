import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { parityFixture, base, project, folder, workspace, org } from './ui-parity.fixture.mjs';

// Browser plugin not available. All requests are isolated by parityFixture.
// Flow: workspace -> preference/rail controls -> bounded geometry, real motion,
// retained editor/search nodes and focus, including an interrupted transition.
test.use({ storageState: { cookies: [], origins: [] } });
const root = `${base}/workspaces/${project.id}`;
const key = 'wme:sidebar:v1:parity-owner';
const preference = (style, side) => ({ version: 1, style, side, navigationVisible: true, contentVisible: true, singleVisible: true });
const settle = page => page.evaluate(async () => {
  // Resize subscriptions commit on the next frame before transitions exist.
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  await Promise.all([...document.querySelectorAll('.sidebar-layout,.sidebar,.sidebar-content-slot,#main,.sidebar-toggle')].flatMap(n => n.getAnimations()).map(a => a.finished.catch(() => {})));
});
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
    const selectors = ['#main', '.sidebar-layout', '.sidebar', '.sidebar-content-slot', '.sidebar-toggle'];
    const frames = [];
    const read = progress => ({ progress, scrollLeft: document.querySelector('.shell-body').scrollLeft, titleY: document.querySelector('#main h2')?.getBoundingClientRect().y, boxes: selectors.map(s => { const n = document.querySelector(s), b = n.getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, opacity: Number(getComputedStyle(n).opacity) }; }) });
    frames.push(read('before')); document.querySelector(action).click(); await Promise.resolve();
    // Sample the browser's actual transition geometry at controlled progress.
    // Real frame timing is reviewed separately; CI scheduling is not a UI gate.
    const animations = [...document.querySelectorAll([...selectors,'.thread-header','.project-pane-header','.page-header'].join(','))].flatMap(n => n.getAnimations());
    for (const animation of animations) animation.pause();
    for (const progress of [0,.2,.4,.6,.8,1]) {
      for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration)*progress;
      frames.push(read(progress));
    }
    for (const animation of animations) animation.finish();
    frames.push(read('finished'));
    return frames;
  }, action);
  expect(frames.every(f => f.scrollLeft === 0)).toBe(true);
  await writeFile(testInfo.outputPath(`${name}-frames.json`), JSON.stringify(frames, null, 2));
  return frames;
}
function moved(frames, index, axis = 'x') {
  const values = frames.map(f => f.boxes[index][axis]), first = values[0], last = values.at(-1);
  expect(Math.abs(last - first)).toBeGreaterThan(20);
  expect(values.some(v => v > Math.min(first,last) + 2 && v < Math.max(first,last) - 2)).toBe(true);
  expect(values.every(v => v >= Math.min(first,last)-.1 && v <= Math.max(first,last)+.1)).toBe(true);
  expect(values.at(-2)).toBeCloseTo(last,1);
}

for (const style of ['adaptive', 'single', 'split']) for (const side of ['left', 'right']) {
  test(`${style} ${side}: bounded 256px rails at medium, two-rail and phone widths`, async ({ page, baseURL }, info) => {
    const state = await setup(page, baseURL, preference(style, side));
    for (const width of [849, 855, 904, 1320, 390]) {
      await page.setViewportSize({ width, height: width === 849 ? 763 : 769 }); await page.goto(workspace);
      await expect(page.getByLabel('Message your agent')).toBeVisible(); await settle(page);
      const main = await rect(page, '#main');
      expect(await page.locator('.platform-header [data-sidebar-reveal], .platform-header .mobile-menu, .sidebar-top, .mobile-close').count()).toBe(0);
      expect(await page.locator('.sidebar-toggle').count()).toBe(style === 'split' ? 2 : 1);
      expect(main.x).toBeGreaterThanOrEqual(0); expect(main.x + main.width).toBeLessThanOrEqual(width);
      expect(main.width).toBeGreaterThanOrEqual(360);
      expect(await page.locator('#main').evaluate(n => !n.inert && getComputedStyle(n).opacity === '1')).toBe(true);
      if (width >= 640) {
        await expect(page.locator('.sidebar-backdrop')).toHaveCount(0);
        await expect(page.locator('.sidebar-content-slot')).toBeVisible({ visible: style !== 'split' || width >= 904 });
        if (style === 'split' && width < 904) {
          await page.getByRole('button', { name:'Show workspace sidebar' }).click(); await settle(page);
          await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('.sidebar-content-slot')).toBeVisible();
          await page.getByRole('button', { name:'Show navigation sidebar' }).click(); await settle(page);
          await expect(page.locator('.sidebar')).toBeVisible();
        }
        for (const rail of await page.locator('.rail-visible').all()) expect((await rail.boundingBox()).width).toBe(256);
        if (width >= 904 && style !== 'single') await expect(page.locator('.sidebar')).toBeVisible();
        if (style !== 'split') await expect(page.locator('[data-sidebar-reveal]')).toHaveCount(0);
        for (const selector of ['.thread-header', '.composer-area', '.send-button']) {
          const b = await rect(page, selector); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x+b.width).toBeLessThanOrEqual(width);
        }
      } else {
        await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('.workspace-detail-rail')).toBeHidden();
        await page.getByRole('button', { name:style === 'split' ? 'Show workspace sidebar' : 'Show navigation sidebar' }).click(); await settle(page);
        expect(await rect(page, '#main')).toEqual(main);
        expect((await rect(page, '.sidebar-content-slot')).width).toBe(256);
        await expect(page.locator('[data-sidebar-hide]')).toHaveCount(1);
        await page.screenshot({ path:info.outputPath(`${style}-${side}-${width}-overlay.png`) });
        await page.locator('[data-sidebar-hide]').click(); await settle(page);
        await expect(page.locator(`[data-sidebar-reveal="${style === 'split' ? 'content' : 'single'}"]`)).toBeFocused();
      }
      await page.screenshot({ path:info.outputPath(`${style}-${side}-${width}.png`) });
    }
    clean(state);
  });
}

test.describe('primary empty workspace reproducer', () => {
  test.use({deviceScaleFactor:2});
test('849 DPR2 empty workspace keeps one title-level toggle, complete welcome and composer', async ({ page, baseURL }, info) => {
  const state = await setup(page, baseURL);
  await page.route('**/projects/parity-project/conversations', route => route.fulfill({ json:{items:[]} }));
  await page.setViewportSize({width:849,height:763}); await page.goto(root);
  await expect(page.getByText('What would you like to work on?')).toBeVisible(); await settle(page);
  const toggle = page.locator('.sidebar-toggle'), before = await toggle.boundingBox();
  const titleY = await page.locator('.thread-header h2').evaluate(n=>n.getBoundingClientRect().y);
  expect((await rect(page,'.sidebar')).width).toBe(256);
  const move = await page.locator('.sidebar .sidebar-move').boundingBox();
  expect(move.x+move.width).toBeLessThanOrEqual(before.x);
  await page.evaluate(()=>window.originalToggle=document.querySelector('.sidebar-toggle'));
  await page.screenshot({path:info.outputPath('empty-849-open.png')});
  const railTitle = page.locator('.workspace-rail-title'), railTitleY = (await railTitle.boundingBox()).y;
  const scrollTop = await page.locator('.workspace-navigation').evaluate(n => { n.scrollTop=100; return n.scrollTop; });
  expect(scrollTop).toBeGreaterThan(0);
  expect((await railTitle.boundingBox()).y).toBe(railTitleY);
  expect(await toggle.boundingBox()).toEqual(before);
  // Scrolling rows must remain behind the fixed title/control band.
  expect(await railTitle.evaluate(n => document.elementFromPoint(n.getBoundingClientRect().x+80,n.getBoundingClientRect().y+34)?.closest('.workspace-rail-title')===n)).toBe(true);
  await page.screenshot({path:info.outputPath('empty-849-scrolled.png')});
  await toggle.click(); await settle(page);
  const after = await toggle.boundingBox(); expect(after.y).toBe(before.y); expect(after.x).toBeLessThan(before.x);
  expect(await toggle.evaluate(n=>n===window.originalToggle)).toBe(true);
  expect(await page.locator('.thread-header h2').evaluate(n=>n.getBoundingClientRect().y)).toBe(titleY);
  await expect(toggle).toHaveAccessibleName('Show navigation sidebar');
  await page.screenshot({path:info.outputPath('empty-849-collapsed.png')});
  for (const selector of ['.workspace-welcome .empty', '.composer-area', '.send-button']) {
    const b=await rect(page,selector); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x+b.width).toBeLessThanOrEqual(849);
  }
  await toggle.click(); await settle(page);
  expect(await page.locator('.workspace-navigation').evaluate(n=>n.scrollTop)).toBe(scrollTop);
  expect((await railTitle.boundingBox()).y).toBe(railTitleY);
  clean(state);
});

});

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

for (const side of ['left','right']) test(`${side}: collapsed control shares each page title band without a vertical jump`, async ({ page,baseURL },info) => {
  const state=await setup(page,baseURL,{...preference('single',side),singleVisible:false});
  for (const route of ['', '/calendar', '/databases', '/settings']) {
    await page.goto(`${root}${route}?conversation=parity-chat`);
    await expect(page.locator('#main')).toContainText(route==='/settings'?'Settings':route==='/calendar'?'Calendar':route==='/databases'?'Databases':'Retained parity conversation');
    await settle(page);
    const main=await rect(page,'#main'), button=await rect(page,'[data-sidebar-reveal="single"]');
    expect(button.width).toBe(36); expect(button.height).toBe(36);
    expect(button.y-main.y).toBe(16);
    expect(side==='left'?button.x-main.x:main.x+main.width-button.x-button.width).toBe(12);
    expect(await page.locator('.platform-header').evaluate(n=>n.getBoundingClientRect().height)).toBe(41);
    const title=await page.locator('#main h1,#main h2').first().boundingBox();
    expect(title.x+title.width<=button.x || title.x>=button.x+button.width || title.y>=button.y+button.height).toBe(true);
    await page.screenshot({path:info.outputPath(`collapsed-${side}-${route.slice(1)||'conversation'}.png`)});
    await page.locator('[data-sidebar-reveal="single"]').click(); await settle(page);
    await page.locator('[data-sidebar-hide="navigation"]').click();
    await expect(page.locator('[data-sidebar-reveal="single"]')).toBeFocused();
  }
  clean(state);
});

for (const side of ['left','right']) test(`${side}: controlled hide/reveal, move, expansion/back and compact motion retain nodes and drafts`,async({page,baseURL},info)=>{
  const state=await setup(page,baseURL,preference('adaptive',side)); await page.goto(`${root}?conversation=parity-chat`);
  const draft=page.getByLabel('Message your agent'); await draft.fill('Unsent motion fixture');
  await page.evaluate(()=>{window.sidebarNodes=[document.querySelector('.sidebar'),document.querySelector('.sidebar-content-slot'),document.querySelector('.composer-area textarea')];});
  moved(await sample(page,'[data-folder-selection]',info,'expand'),0,'width');
  await page.getByRole('searchbox',{name:'Search chats'}).fill('Retained');
  moved(await sample(page,'.sidebar-move',info,'move'),1);
  moved(await sample(page,'.sidebar-back',info,'back'),0,'width');
  const hide = await sample(page,'[data-sidebar-hide="navigation"]',info,'hide');
  moved(hide,0,'width');
  expect(hide.every(f=>Math.abs(f.titleY-hide[0].titleY)<.1)).toBe(true);
  moved(hide,4); expect(hide.every(f=>f.boxes[4].y===hide[0].boxes[4].y)).toBe(true);
  await page.screenshot({path:info.outputPath('collapsed-moved-desktop.png')});
  moved(await sample(page,'[data-sidebar-reveal="single"]',info,'reveal'),0,'width');
  await page.locator('[data-folder-selection]').first().click(); await settle(page);
  await expect(page.getByRole('searchbox',{name:'Search chats'})).toHaveValue('Retained');
  await expect(draft).toHaveValue('Unsent motion fixture');
  await page.setViewportSize({width:849,height:763}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','false'); await settle(page);
  expect((await rect(page,'#main')).width).toBe(569);
  await page.setViewportSize({width:390,height:844}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true'); await settle(page);
  const phone=await sample(page,'[data-sidebar-reveal="single"]',info,'phone-open');
  moved(phone,1); expect(phone.every(f=>f.boxes[0].x===8&&f.boxes[0].width===374)).toBe(true);
  await sample(page,'[data-sidebar-hide]',info,'phone-close');
  expect(await page.evaluate(()=>window.sidebarNodes.every(n=>n.isConnected)&&window.sidebarNodes[2]===document.querySelector('.composer-area textarea'))).toBe(true);
  await expect(draft).toHaveValue('Unsent motion fixture'); clean(state);
});

test('rapid interruptions continue from rendered geometry; reduced motion makes immediate final changes',async({page,baseURL},info)=>{
  const state=await setup(page,baseURL,preference('adaptive','left')); await page.goto(workspace); await expect(page.getByLabel('Message your agent')).toBeVisible(); await settle(page);
  await page.getByRole('searchbox',{name:'Search chats'}).fill('Retained');
  const rapid=await page.evaluate(async()=>{
    const frames=[], rail=document.querySelector('.sidebar-layout');
    for(let i=0;i<5;i++) {
      const before=rail.getBoundingClientRect().x;
      document.querySelector('.sidebar-move').click(); await Promise.resolve();
      // Freeze the transition clock, so continuity does not depend on CI frame
      // scheduling. Reverse at a known intermediate point on every iteration.
      const animations=rail.getAnimations();
      for(const animation of animations) { animation.pause(); animation.currentTime=0; }
      const after=rail.getBoundingClientRect().x;
      for(const animation of animations) animation.currentTime=Number(animation.effect.getTiming().duration)*.4;
      frames.push({before,after,intermediate:rail.getBoundingClientRect().x,animations:animations.length,retained:rail===document.querySelector('.sidebar-layout')});
    }
    for(const animation of rail.getAnimations()) animation.finish();
    return frames;
  });
  await writeFile(info.outputPath('rapid-frames.json'),JSON.stringify(rapid,null,2));
  expect(rapid.every(f=>f.animations>0&&f.retained&&Math.abs(f.after-f.before)<.1&&Math.abs(f.intermediate-f.before)>2)).toBe(true);
  await settle(page); await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-side','right');
  expect((await rect(page,'.sidebar-layout')).x).toBe(page.viewportSize().width-520);
  await expect(page.getByRole('searchbox',{name:'Search chats'})).toHaveValue('Retained');
  await page.emulateMedia({reducedMotion:'reduce'});
  const frames=await sample(page,'.sidebar-move',info,'reduced-motion');
  expect(frames.slice(1).every(f=>Math.abs(f.boxes[1].x-8)<.1)).toBe(true);
  expect(await page.locator('.sidebar-layout').evaluate(n=>n.getAnimations().length)).toBe(0);
  await page.setViewportSize({width:390,height:844}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true'); await settle(page);
  const compact=await sample(page,'[data-sidebar-reveal="single"]',info,'reduced-compact');
  expect(compact.slice(1).every(f=>Math.abs(f.boxes[0].x-8)<.1)).toBe(true);
  clean(state);
});

test('Split controls stay on both center edges; compact content enters and exits only the right edge',async({page,baseURL},info)=>{
  const state=await setup(page,baseURL,{...preference('split','left'),navigationVisible:false,contentVisible:false});
  await page.goto(workspace); await expect(page.getByLabel('Message your agent')).toBeVisible();
  const controls=page.locator('[data-sidebar-reveal]'); await expect(controls).toHaveCount(2);
  const main=await rect(page,'#main'), left=await rect(page,'[data-sidebar-reveal="navigation"]'), right=await rect(page,'[data-sidebar-reveal="content"]');
  expect(left.x-main.x).toBe(12); expect(main.x+main.width-right.x-right.width).toBe(12);
  await page.screenshot({path:info.outputPath('split-both-hidden.png')});
  await page.reload(); await expect(controls).toHaveCount(2);
  for (const width of [390]) {
    await page.setViewportSize({width,height:900}); await expect(page.locator('.app-shell')).toHaveAttribute('data-compact','true'); await settle(page);
    const frames=await sample(page,'[data-sidebar-reveal="content"]',info,`split-right-${width}-open`);
    moved(frames,3); expect(frames.every(f=>f.boxes[3].x>=width-264-.1)).toBe(true);
    expect(frames.every(f=>Math.abs(f.boxes[3].y-frames[0].boxes[3].y)<.1)).toBe(true);
    const close=await sample(page,'[data-sidebar-hide]',info,`split-right-${width}-close`);
    moved(close,3); expect(close.every(f=>f.boxes[3].x>=width-264-.1)).toBe(true);
    expect(close.every(f=>Math.abs(f.boxes[3].y-close[0].boxes[3].y)<.1)).toBe(true);
    await expect(page.locator('[data-sidebar-reveal="content"]')).toBeFocused();
  }
  clean(state);
});

test('resizing a focused rail into a paged layout keeps keyboard focus on its toggle', async ({page,baseURL}) => {
  const state=await setup(page,baseURL);
  for (const style of ['adaptive','split']) {
    await page.setViewportSize({width:1320,height:769});
    await page.goto(workspace);
    await page.evaluate(({key,saved})=>localStorage.setItem(key,JSON.stringify(saved)), {key,saved:preference(style,'right')});
    await page.reload();
    await (style==='split'?page.getByRole('searchbox',{name:'Search chats'}):page.locator('.sidebar').getByRole('link',{name:'Calendar',exact:true})).focus();
    await page.setViewportSize({width:855,height:769});
    await expect(page.locator(`[data-toggle="${style==='split'?'content':'navigation'}"]`)).toBeFocused();
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
  await page.locator('[data-sidebar-hide]').click(); await settle(page);
  await expect(editor).toHaveValue('Unsent synthetic note\n'.repeat(60));
  expect(await editor.evaluate(n=>n===window.noteNode&&n.selectionStart===6&&n.selectionEnd===16)).toBe(true);
  await page.screenshot({path:info.outputPath('retained-mobile-note.png')}); clean(state);
});
