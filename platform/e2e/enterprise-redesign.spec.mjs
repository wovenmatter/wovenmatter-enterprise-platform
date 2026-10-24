import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { parityFixture, org, project, base, workspace } from './ui-parity.fixture.mjs';

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1320, height: 860 } });
const canonical = `${base}/workspaces/${project.id}`;
const evidence = process.env.WME_REDESIGN_EVIDENCE ?? '/tmp/wme-redesign-evidence';
async function setup(page, baseURL, { theme = 'green', role = 'owner', count = 1 } = {}) {
  const state = await parityFixture(page, { baseURL, theme });
  state.content = [{ id: 'note-one', projectId: project.id, kind: 'note', title: 'Research notes', body: '## Launch plan\n\nReview the milestones with the team.', data: { format: 'markdown' }, folderId: null, revision: 1, createdAt: '2026-10-22T09:00:00Z', updatedAt: '2026-10-22T09:00:00Z' }];
  state.mutations = [];
  state.defaults = { defaultHarness: 'pi', agents: {} };
  state.native = { harness: 'codex', runId: 'run-native', configured: {}, settings: { model: 'gpt-5', thinking: 'high', permission: 'default', models: [{id:'gpt-5',label:'GPT-5'}], thinkingLevels:[{id:'high',label:'High'}], permissions:[{id:'default',label:'Ask for approval'}], canSteer:true,canConfigure:true }, interactions: [] };
  state.databases = [{ id:'db-one',name:'Research',revision:1,updatedAt:'2026-10-22T09:00:00Z' }];
  const errors = []; page.on('pageerror', error => errors.push(error.message)); state.errors = errors;
  await page.route('**/enterprise/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.slice('/enterprise/api'.length), method = route.request().method();
    const data = method !== 'GET' ? route.request().postDataJSON() : undefined;
    const respond = json => route.fulfill({ json });
    if (path === '/session') return respond({ user: { id:'parity-owner', role, name:'Synthetic member', email:'synthetic@example.test', theme }, csrfToken:'fixture' });
    if (path === '/organizations') return respond({ items: Array.from({length:count}, (_,i) => ({...org, id:i ? `other-${i}` : org.id, name:i ? `Organization ${i + 1}` : org.name, role:role === 'member' ? 'member' : 'admin'})) });
    if (path.includes('/workspace-content')) {
      const suffix = path.split('/workspace-content')[1];
      if (method !== 'GET') state.mutations.push({path,method,data});
      if (!suffix && method === 'GET') return respond({items:state.content.filter(item => !url.searchParams.has('kind') || item.kind === url.searchParams.get('kind'))});
      if (!suffix && method === 'POST') { const item={...data,id:`record-${state.content.length+1}`,projectId:project.id,revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};state.content.push(item);return respond(item); }
      const id = suffix.split('/')[1], item = state.content.find(item => item.id === id);
      if (suffix.endsWith('/versions')) return respond({items:[{...item,revision:1,body:'Original note'}]});
      if (suffix.endsWith('/runs')) return respond({items:[],state:{nextAt:null,lastStatus:'pending'}});
      if (suffix.endsWith('/restore')) { Object.assign(item,{body:'Original note',revision:item.revision+1});return respond(item); }
      if (method === 'PATCH') { Object.assign(item,data,{revision:item.revision+1});return respond(item); }
      if (method === 'DELETE') { state.content=state.content.filter(item => item.id!==id);return respond({ok:true}); }
      return respond(item);
    }
    if (path.endsWith('/agent-settings')) { if(method === 'PATCH') state.defaults=data;return respond(state.defaults); }
    if (path.endsWith('/workspace-library')) return respond({items:[{id:'link-one',title:'Design reference',type:'link',url:'https://example.test/design',sender:'agent',harness:'pi',conversationId:'parity-chat',saved:false,sentAt:'2026-10-22T09:00:00Z'},...state.content.filter(item=>item.kind==='library').map(item=>({...item,...item.data,saved:true,sender:'member'}))]});
    if (path === `/projects/${project.id}/usage`) return respond({items:[{harness:'pi',model:'parity-model',runs:4,completed:3,failed:1,inputTokens:null,outputTokens:null,cost:null,totalTokens:1200,measuredRuns:4}],totals:{runs:4,completed:3,failed:1}});
    if (path.endsWith('/databases')) { state.mutations.push({path,method,data}); if(data.action==='list')return respond({databases:state.databases});if(data.action==='create'){const database={id:'db-new',name:data.name,revision:1};state.databases.push(database);return respond({database});}if(data.action==='query')return respond({query:{contractVersion:1,columns:['name','total'],rows:[['Launch','3']]}});return respond({changes:1}); }
    if (path.endsWith('/native/respond')) { state.mutations.push({path,method,data});state.native.interactions=[];return respond({delivery:'confirmed'}); }
    if (path.endsWith('/native')) return respond(state.native);
    if (path === '/accounts') return respond({items:[{id:'person',name:'Workspace member',email:'member@example.test',enabled:true,role:'member',memberships:[{orgId:org.id,organizationName:org.name,role:'member'}]}]});
    if (path === '/platform/settings') return respond({owner:{name:'Platform owner',email:'owner@example.test'},organizations:2,accounts:4,hosts:[{id:'host',name:'Workspace host',status:'ready'}]});
    if (path === '/me' && method === 'PATCH') return respond({id:'parity-owner',role,name:'Synthetic member',theme:data.theme});
    return route.fallback();
  });
  return state;
}

for (const theme of ['green','cognac','dark']) test(`${theme}: platform, organization and adaptive workspace match desktop structure`, async ({page,baseURL}) => {
  const state=await setup(page,baseURL,{theme});await mkdir(evidence,{recursive:true});
  await page.goto('/enterprise/');await expect(page.getByRole('heading',{name:'Admin',exact:true})).toBeVisible();await expect(page.locator('.sidebar')).toHaveCount(0);await expect(page.getByRole('link',{name:'Accounts',exact:true})).toBeVisible();
  await page.screenshot({path:`${evidence}/${theme}-platform.png`});
  await page.locator('main').getByRole('link',{name:'Organizations',exact:true}).click();await page.getByRole('link',{name:org.name,exact:true}).click();await expect(page).toHaveURL(new RegExp('/workspaces$'));await expect(page.getByRole('navigation',{name:'Organization navigation'})).toBeVisible();await expect(page.getByRole('link',{name:'Organization Files',exact:true})).toBeVisible();
  await page.screenshot({path:`${evidence}/${theme}-organization.png`});
  await page.goto(workspace);await expect(page.getByRole('heading',{name:'Retained parity conversation',exact:true})).toBeVisible();
  for(const name of ['Pi Durable','Codex','Claude Code','Grok Build','OpenCode']) await expect(page.locator('.sidebar').getByRole('link',{name,exact:true})).toBeVisible();
  await expect(page.getByRole('complementary',{name:'Workspace content'})).toBeVisible();await expect(page.getByRole('button',{name:'Conversation members'})).toHaveCount(0);await expect(page.locator('.session-mode')).toHaveCount(0);
  const widths=await page.locator('.sidebar,.sidebar-content-slot').evaluateAll(elements=>elements.map(element=>Math.round(element.getBoundingClientRect().width)));expect(widths).toEqual([256,256]);
  await page.getByRole('tab',{name:'Notes',exact:true}).click();await page.getByRole('link',{name:'Research notes',exact:true}).click();await expect(page.getByRole('textbox',{name:'Document body'})).toHaveValue(/Launch plan/);await expect(page.getByRole('heading',{name:'Retained parity conversation',exact:true})).toBeVisible();
  await page.screenshot({path:`${evidence}/${theme}-workspace-note.png`});await page.getByRole('button',{name:'Close note',exact:true}).click();await expect(page.getByRole('region',{name:'Open note'})).toHaveCount(0);await page.screenshot({path:`${evidence}/${theme}-workspace.png`});expect(state.errors).toEqual([]);expect(state.external).toEqual([]);
});

test('membership landing, legacy workspace redirects and mobile drawer',async({page,baseURL})=>{
  const state=await setup(page,baseURL,{role:'member'});await page.goto('/enterprise/');await expect(page).toHaveURL(new RegExp('/workspaces$'));for(const name of ['Members','Connections','Settings'])await expect(page.getByRole('navigation',{name:'Organization navigation'}).getByRole('link',{name,exact:true})).toHaveCount(0);
  await page.goto(`${base}/projects/${project.id}?folder=all`);await expect(page).toHaveURL(new RegExp('/workspaces/'+project.id));await expect(page.getByRole('textbox',{name:'Message your agent',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Show navigation sidebar'}).click();await page.getByRole('button',{name:'Back to workspace navigation'}).click();await expect(page.getByRole('dialog',{name:'Navigation'})).toBeVisible();await page.getByRole('link',{name:'Calendar',exact:true}).click();await expect(page.getByRole('heading',{name:'Calendar',exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Navigation'})).toHaveCount(0);await page.screenshot({path:`evidence/mobile-calendar.png`.replace('evidence',evidence)});expect(state.errors).toEqual([]);
});

test('notes format, save, query insertion, history and reload persist',async({page,baseURL})=>{
  const state=await setup(page,baseURL);await page.goto(`${canonical}/notes?item=note-one`);const editor=page.getByRole('textbox',{name:'Document body'});await expect(editor).toHaveValue(/Launch plan/);await editor.fill('Decisions');await page.getByRole('button',{name:'Format note',exact:true}).click();await page.getByRole('menuitem',{name:'Bold',exact:true}).click();await expect(editor).toHaveValue(/\*\*/);await page.getByRole('button',{name:'Save',exact:true}).click();expect(state.content[0].revision).toBe(2);
  await editor.selectText();await page.getByRole('button',{name:'Insert database query',exact:true}).click();await page.getByLabel('Database',{exact:true}).selectOption('db-one');await page.getByRole('button',{name:'Insert results',exact:true}).click();await expect(editor).toHaveValue(/Launch.*3/);await page.getByRole('button',{name:'Save',exact:true}).click();await page.reload();await expect(editor).toHaveValue(/Launch.*3/);
  await page.getByRole('button',{name:'Version history',exact:true}).click();await page.getByRole('button',{name:'Restore',exact:true}).click();await expect(editor).toHaveValue('Original note');await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.locator('.document-preview')).toContainText('Original note');expect(state.errors).toEqual([]);
});

test('calendar event and recurring task create, disable and persist',async({page,baseURL})=>{
  const state=await setup(page,baseURL);await page.goto(`${canonical}/calendar`);await page.locator('.calendar-header').getByRole('button',{name:'Add event',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Planning');await page.getByLabel('Repeat',{exact:true}).selectOption('week');await page.getByRole('button',{name:'Create event',exact:true}).click();await expect(page.locator('.agenda-title').filter({hasText:'Planning'})).toBeVisible();expect(state.content.at(-1).data.recurrence).toEqual({unit:'week',interval:1});
  await page.goto(`${canonical}/tasks`);await page.getByRole('button',{name:'New task',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Daily research');await page.getByLabel('Prompt',{exact:true}).fill('Summarize the workspace notes');await page.getByLabel('Agent',{exact:true}).selectOption('codex');await page.getByRole('button',{name:'Create task',exact:true}).click();await expect(page.getByRole('button',{name:/^Daily research/})).toBeVisible();await page.getByRole('switch',{name:'Enable Daily research'}).uncheck();await expect.poll(()=>state.content.at(-1).data.enabled).toBe(false);await page.reload();await expect(page.getByRole('switch',{name:'Enable Daily research'})).not.toBeChecked();expect(state.errors).toEqual([]);
});

test('workspace library, SQLite workbench, usage and scoped settings',async({page,baseURL})=>{
  const state=await setup(page,baseURL);await page.goto(`${canonical}/library`);await page.getByRole('button',{name:'Save link',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Useful resource');await page.getByLabel('URL',{exact:true}).fill('https://example.test/resource');await page.getByRole('dialog').getByRole('button',{name:'Save link',exact:true}).click();await expect(page.getByRole('link',{name:'Useful resource',exact:true})).toBeVisible();
  await page.goto(`${canonical}/databases`);await page.getByRole('button',{name:'Run query',exact:true}).click();await expect(page.getByRole('cell',{name:'Launch',exact:true})).toBeVisible();await page.getByLabel('SQL',{exact:true}).fill('CREATE TABLE ideas (title TEXT)');await page.getByRole('button',{name:'Execute changes',exact:true}).click();await expect(page.getByRole('status')).toHaveText('Statement executed.');expect(state.mutations.some(entry=>entry.data.action==='execute')).toBe(true);
  await page.goto(`${canonical}/usage`);await expect(page.getByRole('cell',{name:'Unavailable',exact:true})).toHaveCount(3);await page.goto(`${canonical}/settings`);await page.getByLabel('Default agent',{exact:true}).selectOption('codex');await page.getByRole('button',{name:'Save agent defaults',exact:true}).click();expect(state.defaults.defaultHarness).toBe('codex');await page.getByRole('link',{name:'Connections',exact:true}).click();await expect(page.getByRole('heading',{name:'Connections',exact:true})).toBeVisible();expect(state.errors).toEqual([]);
});

test('all five agents are selectable and native approval responses reach backend',async({page,baseURL})=>{
  const state=await setup(page,baseURL);await page.goto(`${canonical}?new=1&agent=claude_code`);await expect(page.getByRole('dialog').getByLabel('Agent',{exact:true})).toHaveValue('claude_code');await expect(page.getByRole('dialog').getByLabel('Agent',{exact:true}).locator('option')).toHaveCount(5);await expect(page.getByText('Session permissions',{exact:true})).toHaveCount(0);
  await page.route('**/enterprise/api/conversations/parity-chat',route=>route.fulfill({json:{id:'parity-chat',title:'Native test',harness:'codex',model:'gpt-5',folderId:null,createdBy:'another-member',mode:'write'}}));state.native.interactions=[{id:'approval-one',kind:'approval',title:'Run test suite?',detail:'npm test',options:[{id:'allow_once',label:'Allow once'},{id:'deny',label:'Deny'}],questions:[]}];
  await page.goto(workspace);await expect(page.getByRole('region',{name:'Agent approval'})).toBeVisible();await page.getByRole('button',{name:'Allow once',exact:true}).click();await expect(page.getByRole('region',{name:'Agent approval'})).toHaveCount(0);expect(state.mutations.at(-1).data.optionID).toBe('allow_once');expect(state.errors).toEqual([]);
});

test('calendar month-end recurrence clamps to February and preserves original March anchor',async({page,baseURL})=>{
  await page.clock.setFixedTime(new Date('2027-01-31T12:00:00Z'));
  const state=await setup(page,baseURL);state.content.push({id:'monthly',kind:'event',title:'Month end',body:'',revision:1,data:{startsAt:'2027-01-31T09:00:00Z',timeZone:'UTC',recurrence:{unit:'month',interval:1}}});
  await page.goto(`${canonical}/calendar`);await page.getByRole('button',{name:'Next month',exact:true}).click();await page.getByRole('button',{name:'Sunday, February 28, 2027',exact:true}).click();await expect(page.locator('.agenda-title').filter({hasText:'Month end'})).toBeVisible();await page.getByRole('button',{name:'Next month',exact:true}).click();await page.getByRole('button',{name:'Wednesday, March 31, 2027',exact:true}).click();await expect(page.locator('.agenda-title').filter({hasText:'Month end'})).toBeVisible();expect(state.errors).toEqual([]);
});

test('native conditional forms expose supported controls and serialize active typed answers',async({page,baseURL})=>{
  const state=await setup(page,baseURL);
  await page.route('**/enterprise/api/conversations/parity-chat',route=>route.fulfill({json:{id:'parity-chat',title:'Native form',harness:'opencode',model:'gpt-5',folderId:null,createdBy:'another-member',mode:'write'}}));
  state.native.harness='opencode';state.native.interactions=[{id:'form',kind:'question',title:'Configure deployment',options:[],questions:[
    {id:'enabled',prompt:'Use advanced settings',type:'boolean',required:false,options:[],default:['false']},
    {id:'count',prompt:'Workers',type:'integer',required:true,options:[],default:['2'],when:[{key:'enabled',op:'eq',value:true}]},
    {id:'target',prompt:'Target',type:'string',required:true,options:[{id:'staging',label:'Staging'}],allowsFreeText:true,default:['staging']},
    {id:'verified',prompt:'Verify connection',type:'external',required:true,options:[],url:'https://example.test/verify'},
  ]}];
  await page.goto(workspace);await expect(page.getByLabel('Answer: Workers',{exact:true})).toHaveCount(0);await page.getByRole('switch',{name:'Yes',exact:true}).check();await page.getByLabel('Answer: Workers',{exact:true}).fill('3');await page.getByLabel('Choose: Target',{exact:true}).selectOption('__custom__');await page.getByLabel('Answer: Target',{exact:true}).fill('Preview');await expect(page.getByRole('button',{name:'Send answers',exact:true})).toBeDisabled();await page.getByRole('switch',{name:'I’ve completed this step',exact:true}).check();await page.getByRole('button',{name:'Send answers',exact:true}).click();await expect(page.getByRole('region',{name:'Agent question'})).toHaveCount(0);expect(state.mutations.at(-1).data.answers).toEqual({enabled:['true'],count:['3'],target:['Preview'],verified:['true']});expect(state.errors).toEqual([]);expect(state.external).toEqual([]);
});

test('workspace default agent and multi-organization chooser respect saved membership scope',async({page,baseURL})=>{
  const state=await setup(page,baseURL,{role:'member',count:2});state.defaults.defaultHarness='grok_build';await page.goto('/enterprise/');await expect(page.getByRole('heading',{name:'Your organizations',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Accounts',exact:true})).toHaveCount(0);await expect(page.locator('.sidebar')).toHaveCount(0);await page.goto(`${canonical}?folder=all`);await expect(page.locator('.composer-area').getByRole('button',{name:/^Agent /})).toHaveCount(0);await expect(page.getByRole('button',{name:/^Thinking level /})).toBeDisabled();await page.goto(`${canonical}?folder=all&new=1`);await expect(page.getByRole('dialog').getByLabel('Agent',{exact:true})).toHaveValue('grok_build');expect(state.errors).toEqual([]);
});

test('native multiselect conditions and rejected response correction preserve native form semantics',async({page,baseURL})=>{
  const state=await setup(page,baseURL);
  await page.route('**/enterprise/api/conversations/parity-chat',route=>route.fulfill({json:{id:'parity-chat',title:'Native conditional form',harness:'opencode',model:'gpt-5',folderId:null,createdBy:'another-member',mode:'write'}}));
  state.native.harness='opencode';state.native.interactions=[{id:'conditional-form',kind:'question',title:'Select deployment target',options:[],questions:[
    {id:'targets',prompt:'Targets',type:'multiselect',options:[{id:'preview',label:'Preview'}],default:[]},
    {id:'region',prompt:'Preview region',type:'string',required:true,options:[],when:[{key:'targets',op:'eq',value:'preview'}]},
    {id:'optional',prompt:'Optional label',type:'string',options:[]},
    {id:'hidden-dependent',prompt:'Must stay hidden',type:'string',options:[],when:[{key:'optional',op:'neq',value:'excluded'}]},
  ]}];
  const submitted=[];await page.route('**/enterprise/api/conversations/parity-chat/native/respond',async route=>{submitted.push(route.request().postDataJSON());if(submitted.length===1)return route.fulfill({json:{delivery:'rejected',error:'Choose a different region.'}});state.native.interactions=[];return route.fulfill({json:{delivery:'confirmed'}});});
  await page.goto(workspace);await expect(page.getByLabel('Answer: Preview region',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Answer: Must stay hidden',{exact:true})).toHaveCount(0);await page.getByRole('switch',{name:'Preview',exact:true}).check();await page.getByLabel('Answer: Preview region',{exact:true}).fill('first');await page.getByRole('button',{name:'Send answers',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Choose a different region.');await page.getByLabel('Answer: Preview region',{exact:true}).fill('second');await page.getByRole('button',{name:'Send answers',exact:true}).click();await expect(page.getByRole('region',{name:'Agent question'})).toHaveCount(0);expect(submitted).toHaveLength(2);expect(submitted[0].requestId).not.toBe(submitted[1].requestId);expect(submitted[1].answers).toEqual({targets:['preview'],region:['second'],optional:[]});expect(state.errors).toEqual([]);
});

test('workspace Library updates retained download availability and opens saved artifacts',async({page,baseURL})=>{
  const state=await setup(page,baseURL);const file={id:'retained-file',title:'Research export.csv',type:'file',sender:'agent',harness:'codex',saved:false,storage:'pending',retentionStatus:'pending'};const unavailable={id:'missing-file',title:'Unavailable photo.png',type:'photo',sender:'agent',saved:false,storage:'unavailable',retentionStatus:'unavailable',retentionError:'The source file is no longer available.'};
  await page.route('**/enterprise/api/projects/*/workspace-library',route=>route.fulfill({json:{items:[file,unavailable,{id:'artifact-one',title:'Saved analysis',type:'artifact',sender:'member',saved:true,storage:'saved'}]}}));
  await page.goto(`${canonical}/library`);await expect(page.getByRole('status')).toHaveText('Saving a workspace copy…');await expect(page.getByRole('link',{name:'Research export.csv',exact:true})).toHaveCount(0);await expect(page.getByText('The source file is no longer available.',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Unavailable photo.png',exact:true})).toHaveCount(0);await page.getByRole('tab',{name:'Saved Artifacts',exact:true}).click();await expect(page.getByRole('link',{name:'Saved analysis',exact:true})).toHaveAttribute('href',`${canonical}/artifacts?item=artifact-one`);await page.getByRole('tab',{name:'Messages',exact:true}).click();
  const downloadUrl=`/enterprise/api/projects/${project.id}/workspace-library/retained-file/download`;Object.assign(file,{retentionStatus:'retained',storage:'retained',downloadUrl});await expect(page.getByRole('link',{name:'Research export.csv',exact:true})).toHaveAttribute('href',downloadUrl,{timeout:6000});await expect(page.getByRole('status')).toHaveCount(0);expect(state.errors).toEqual([]);
});

test('platform owner manages cross-organization memberships without replacing pending identities',async({page,baseURL})=>{
  const state=await setup(page,baseURL,{count:2});const account={id:'existing-pending',name:'Pending colleague',email:'pending@example.test',role:'member',enabled:false,invitationPending:true,memberships:[{orgId:org.id,organizationName:org.name,role:'member'}]};const changes=[];
  await page.route('**/enterprise/api/accounts',route=>{if(route.request().method()==='GET')return route.fulfill({json:{items:[account,{id:'platform-owner',name:'Platform owner',email:'owner@example.test',role:'owner',enabled:true,memberships:[]}]}});const body=route.request().postDataJSON();changes.push(body);account.memberships.push({orgId:body.orgId,organizationName:'Organization 2',role:body.role});return route.fulfill({status:202,json:{user:account,activationUrl:'https://example.test/enterprise/activate?token=renewed'}});});
  await page.route('**/enterprise/api/organizations/*/members/existing-pending',route=>{const id=new URL(route.request().url()).pathname.split('/')[4];const body=route.request().postDataJSON();changes.push({method:route.request().method(),orgId:id,...body});if(route.request().method()==='DELETE')account.memberships=account.memberships.filter(item=>item.orgId!==id);else account.memberships.find(item=>item.orgId===id).role=body.role;return route.fulfill({json:{ok:true}});});
  await page.goto('/enterprise/accounts');await expect(page.locator('.sidebar')).toHaveCount(0);await expect(page.getByRole('button',{name:'Manage memberships',exact:true})).toHaveCount(1);await page.getByRole('button',{name:'Manage memberships',exact:true}).click();const modal=page.getByRole('dialog',{name:'Memberships for Pending colleague',exact:true});await modal.getByLabel(`Role in ${org.name}`,{exact:true}).selectOption('admin');await expect.poll(()=>account.memberships[0].role).toBe('admin');await modal.getByLabel('Add to organization',{exact:true}).selectOption('other-1');await modal.getByLabel('Organization role',{exact:true}).selectOption('member');await modal.getByRole('button',{name:'Add membership',exact:true}).click();await expect(modal.getByLabel('Renewed invitation link',{exact:true})).toHaveValue(/token=renewed/);expect(changes.find(change=>change.email)).toEqual({email:'pending@example.test',name:'Pending colleague',orgId:'other-1',role:'member'});await modal.getByRole('button',{name:'Remove Organization 2 membership',exact:true}).click();await page.getByRole('dialog',{name:'Remove membership?',exact:true}).getByRole('button',{name:'Remove membership',exact:true}).click();await expect(modal.getByLabel('Role in Organization 2',{exact:true})).toHaveCount(0);expect(account.id).toBe('existing-pending');expect(account.memberships).toHaveLength(1);expect(state.errors).toEqual([]);
});
