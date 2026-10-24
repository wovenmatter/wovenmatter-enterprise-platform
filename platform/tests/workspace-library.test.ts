import { test } from 'node:test';
const { openNativeArchive } = await import(new URL('../packages/runtime/src/embedded/default-agent/src/native-journal.mjs', import.meta.url).href);
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, symlink, link, rm, access, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { platformFixture } from './fixtures/platform.js';
import { uploadFile, deleteFile, shareFile } from '../apps/api/src/files/service.js';
import { captureNativeBatch, projectNativeUpdate } from '../apps/api/src/conversations/activity.js';
import { purgeExpiredProject } from '../apps/api/src/projects/trash.js';
import { scopeRoot } from '../apps/api/src/files/paths.js';
import { prepareConversationDirectory } from '../apps/api/src/projects/workspaces.js';
import { discoverLibraryAssets, libraryFilePath } from '../apps/api/src/workspace-content/library-parser.js';
import { captureLibraryMessage, captureLibraryNativeBatch } from '../apps/api/src/workspace-content/library-storage.js';

async function message(f: Awaited<ReturnType<typeof platformFixture>>, content: string, fixed = false) {
 const chat = await f.conversations.create(f.users.full!, f.projectA, { title: 'Retained handbacks' });
 const row = (await f.db.get<any>('SELECT * FROM conversations WHERE id=?', [chat.id]))!;
 if (fixed) await prepareConversationDirectory(f.ctx, row, 'Deterministic handbacks');
 const id = randomUUID();
 await f.db.run("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES(?,?,'assistant',?,?)", [id, chat.id, content, new Date().toISOString()]);
 return { id, chat, row: (await f.db.get<any>('SELECT * FROM conversations WHERE id=?', [chat.id]))! };
}
const endpoint = (f: Awaited<ReturnType<typeof platformFixture>>) => `/enterprise/api/projects/${f.projectA}/workspace-library`;

test('desktop discovery preserves Markdown, reference, file, sandbox, MEDIA and plain URL handbacks with bounds', () => {
 const assets = discoverLibraryAssets('[chart](sandbox:/workspace/chart.png) [report](reports/report.csv "Title") [file](file:///workspace/report.pdf)\n[foot]: https://example.test/reference\nMEDIA: output/photo.heif\nhttps://example.test/plain. <https://example.test/angle>\n```[secret](file:///session/private)```\n~~~https://secret.test~~~\n/etc/passwd arbitrary.txt [bad](javascript:alert(1))');
 assert.deepEqual(assets.map(a => a.source), ['sandbox:/workspace/chart.png','reports/report.csv','file:///workspace/report.pdf','https://example.test/reference','https://example.test/plain','https://example.test/angle','output/photo.heif']);
 assert.equal(assets[0]!.type, 'photo'); assert.equal(assets[1]!.type, 'file');
 assert.equal(discoverLibraryAssets(Array.from({length: 250}, (_, i) => `[${i}](file:///workspace/${i}.txt)`).join(' ')).length, 200);
 assert.equal(libraryFilePath('file://localhost/workspace/space%20name.txt'), '/workspace/space name.txt');
 for (const bad of ['file://remote/workspace/x','sandbox:/workspace/../control/token','/workspace/%2e%2e/control','/workspace/%00','/workspace/a\\b']) assert.throws(() => libraryFilePath(bad));
});

test('saved file and photo bytes are immutable, retained at creation, scoped, and survive source deletion', async t => {
 const f = await platformFixture(t), base = `/enterprise/api/projects/${f.projectA}/workspace-content`;
 for (const [type, name] of [['file','output.txt'],['photo','chart.png']]) {
  const file = await uploadFile(f.ctx, f.users.full!, {orgId:f.orgA,projectId:f.projectA}, name!, Buffer.from('immutable-' + type));
  const saved = (await f.request('full','POST',base,{kind:'library',title:name,data:{type,fileId:file.id}})).json();
  await deleteFile(f.ctx, f.users.full!, file.id, f.projectA);
  const item = (await f.request('read','GET',endpoint(f))).json().items.find((i:any) => i.id === saved.id);
  assert.equal(item.retentionStatus, 'retained'); assert.equal(item.fileId,file.id);
  assert.equal((await f.request('read','GET',item.downloadUrl)).body,'immutable-' + type);
  const renamed = await f.request('full','PATCH',`${base}/${saved.id}`,{expectedRevision:1,title:'Retained title'});
  assert.equal(renamed.statusCode,200);
  assert.equal((await f.request('read','GET',item.downloadUrl)).body,'immutable-' + type);
  assert.equal((await f.request('other','GET',item.downloadUrl)).statusCode,404);
  assert.equal((await f.request('other','GET',item.downloadUrl.replace(f.projectA,f.projectB))).statusCode,404);
  await f.workspaceContent.service.remove(f.users.full!,f.projectA,saved.id,2);
  assert.equal((await f.request('full','POST',`${endpoint(f)}/${saved.id}/retry`,{})).statusCode,404);
  assert.equal((await f.request('full','GET',item.downloadUrl)).statusCode,404);
 }
});

test('accepted native handbacks retain bytes before first Library view and resolve relative references against the fixed chat directory', async t => {
 const f = await platformFixture(t);
 const m = await message(f,'[chart](sandbox:/workspace/chart.png) [relative](result.txt) MEDIA: ./photo.webp',true);
 const root = scopeRoot(f.ctx,{orgId:f.orgA,projectId:f.projectA});
 await writeFile(join(root,'chart.png'),'absolute');
 await writeFile(join(root,m.row.working_directory,'result.txt'),'relative');
 await writeFile(join(root,m.row.working_directory,'photo.webp'),'photo');
 await f.conversations.onMessageAccepted!(f.users.full!,f.projectA,m.id);
 await unlink(join(root,'chart.png')); await rm(join(root,m.row.working_directory),{recursive:true});
 const items = (await f.request('read','GET',endpoint(f))).json().items;
 assert.equal(items.length,3);
 for (const item of items) { assert.equal(item.retentionStatus,'retained'); assert.equal(item.conversationId,m.chat.id); }
 assert.deepEqual((await Promise.all(items.map((i:any)=>f.request('read','GET',i.downloadUrl)))).map(r=>r.body).sort(),['absolute','photo','relative']);
});

test('handbacks deny host/private/traversal paths, symlinks and hardlinks without exposing server errors', async t => {
 const f=await platformFixture(t), root=scopeRoot(f.ctx,{orgId:f.orgA,projectId:f.projectA});
 await mkdir(root,{recursive:true});
 const outside=join(f.stateDir,'private-secret.txt'); await writeFile(outside,'PRIVATE SECRET');
 await symlink(outside,join(root,'link.txt')); await link(outside,join(root,'hard.txt'));
 await symlink(f.stateDir,join(root,'redirect'));
 const sources=['file:///etc/passwd','file:///session/token','sandbox:/control/platform.sqlite','sandbox:/workspace/../private-secret.txt','sandbox:/workspace/%2e%2e/private-secret.txt','sandbox:/workspace/link.txt','sandbox:/workspace/hard.txt','sandbox:/workspace/redirect/private-secret.txt','file://remote/workspace/secret'];
 const m=await message(f,sources.map((s,i)=>`[${i}](<${s}>)`).join(' '));
 await captureLibraryMessage(f.ctx,f.users.full!,f.projectA,m.id);
 const response=await f.request('read','GET',endpoint(f));
 assert.equal(response.json().items.length,sources.length);
 for (const item of response.json().items) { assert.equal(item.retentionStatus,'unavailable'); assert.equal(item.downloadUrl,null); assert.ok(!item.retentionError.includes(f.stateDir)); }
 assert.equal((await f.db.get<any>('SELECT COUNT(*) n FROM workspace_library_blobs'))!.n,0);
 assert.ok(!response.body.includes('PRIVATE SECRET'));
});

test('organization shares and cross-workspace citations never become permanent workspace grants', async t => {
 const f=await platformFixture(t), root=scopeRoot(f.ctx,{orgId:f.orgA,projectId:f.projectA});
 const org=await uploadFile(f.ctx,f.users.admin!,{orgId:f.orgA},'private.txt',Buffer.from('org private'));
 await shareFile(f.ctx,f.users.admin!,org.id,f.projectA,'read');
 const share=(await f.db.get<any>('SELECT name FROM workspace_file_shares WHERE project_id=?',[f.projectA]))!;
 await mkdir(root,{recursive:true}); await writeFile(join(root,share.name),'shadow content');
 const other=await uploadFile(f.ctx,f.users.other!,{orgId:f.orgB,projectId:f.projectB},'other.txt',Buffer.from('other private'));
 const m=await message(f,`[shared](sandbox:/workspace/${share.name})`);
 await f.db.run('UPDATE conversation_messages SET citations=? WHERE id=?',[JSON.stringify([{fileId:org.id},{fileId:other.id}]),m.id]);
 await captureLibraryMessage(f.ctx,f.users.full!,f.projectA,m.id);
 const items=(await f.request('read','GET',endpoint(f))).json().items;
 assert.equal(items.length,1); assert.equal(items[0].retentionStatus,'unavailable');
 assert.equal((await f.request('full','POST',`/enterprise/api/projects/${f.projectA}/workspace-content`,{kind:'library',title:'No grant',data:{type:'file',fileId:org.id}})).statusCode,400);
 assert.equal((await f.db.get<any>('SELECT COUNT(*) n FROM workspace_library_blobs'))!.n,0);
});

test('retained downloads revalidate membership after reading bytes and disabled members cannot retain', async t => {
 const f=await platformFixture(t);
 const file=await uploadFile(f.ctx,f.users.full!,{orgId:f.orgA,projectId:f.projectA},'output.txt',Buffer.from('private download'));
 const saved=await f.workspaceContent.service.create(f.users.full!,f.projectA,{kind:'library',title:'Output',data:{type:'file',fileId:file.id}});
 const url=`${endpoint(f)}/${saved.id}/download`, requireProject=f.ctx.requireProject.bind(f.ctx);
 let calls=0;
 f.ctx.requireProject=async(user,id,access)=>{
  if(user.id===f.users.read!.id && ++calls===2) await f.db.run('DELETE FROM project_members WHERE project_id=? AND user_id=?',[f.projectA,user.id]);
  return requireProject(user,id,access);
 };
 const response=await f.request('read','GET',url); assert.equal(response.statusCode,404); assert.ok(!response.body.includes('private download'));
 const m=await message(f,'[late](sandbox:/workspace/output.txt)');
 await assert.rejects(captureLibraryMessage(f.ctx,f.users.read!,f.projectA,m.id));
 assert.equal((await f.db.get<any>('SELECT COUNT(*) n FROM workspace_library_items WHERE message_id=?',[m.id]))!.n,0);
});

test('Library applies file size and per-workspace quota limits and exposes retryable truthful states', async t=>{
 const f=await platformFixture(t), root=scopeRoot(f.ctx,{orgId:f.orgA,projectId:f.projectA});
 await mkdir(root,{recursive:true}); await writeFile(join(root,'small.txt'),'1234'); await writeFile(join(root,'large.txt'),'123456789');
 f.ctx.config.maxFileBytes=8; f.ctx.config.libraryQuotaBytes=3;
 const m=await message(f,'[small](sandbox:/workspace/small.txt) [large](sandbox:/workspace/large.txt)');
 await captureLibraryMessage(f.ctx,f.users.full!,f.projectA,m.id);
 const items=(await f.request('read','GET',endpoint(f))).json().items;
 assert.ok(items.find((i:any)=>i.title==='small').retentionError.includes('allowance'));
 assert.ok(items.find((i:any)=>i.title==='large').retentionError.includes('size limit'));
 f.ctx.config.libraryQuotaBytes=8;
 const small=items.find((i:any)=>i.title==='small');
 assert.equal((await f.request('full','POST',`${endpoint(f)}/${small.id}/retry`,{})).statusCode,200);
 assert.equal((await f.request('read','GET',`${endpoint(f)}/${small.id}/download`)).body,'1234');
});

test('native content attachments are retained while tool records and configuration payloads are excluded',async t=>{
 const f=await platformFixture(t),m=await message(f,'');
 const attachment={role:'assistant',content:[{type:'image',fileName:'native.png',data:Buffer.from('embedded image').toString('base64')},{type:'file',fileName:'remote.pdf',url:'https://example.test/remote.pdf',data:Buffer.from('delivered remote bytes').toString('base64')}]};
 await captureLibraryNativeBatch(f.ctx,f.users.full!,f.projectA,m.id,{records:[{payload:JSON.stringify({type:'message',message:attachment})},{payload:JSON.stringify({type:'tool_result',message:{...attachment,content:[{type:'file',data:Buffer.from('TOOL PRIVATE').toString('base64')}]}})}]});
 const items=(await f.request('read','GET',endpoint(f))).json().items;
 assert.equal(items.length,2);
 for (const item of items) assert.equal(item.retentionStatus,'retained');
 const photo=items.find((i:any)=>i.type==='photo'), remote=items.find((i:any)=>i.source.startsWith('https:'));
 assert.equal((await f.request('read','GET',photo.downloadUrl)).body,'embedded image');
 assert.equal((await f.request('read','GET',remote.downloadUrl)).body,'delivered remote bytes');
});

async function completedRun(f:any,harness='pi') {
 await f.conversations.close();
 const chat=await f.conversations.create(f.users.full,f.projectA,{title:'Independent native attachment replay'});
 const run={id:randomUUID(),conversation_id:chat.id,org_id:f.orgA,project_id:f.projectA,user_id:f.users.full.id,assistant_message_id:randomUUID()},userMessage=randomUUID(),at=new Date().toISOString();
 for(const [id,role] of [[userMessage,'user'],[run.assistant_message_id,'assistant']]) await f.db.run('INSERT INTO conversation_messages(id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?)',[id,chat.id,run.id,role,'',at]);
 await f.db.run("INSERT INTO conversation_runs(id,conversation_id,org_id,project_id,user_id,request_id,user_message_id,assistant_message_id,status,mode,harness,model,created_at) VALUES(?,?,?,?,?,?,?,?,'completed','write',?,'fixture',?)",[run.id,chat.id,f.orgA,f.projectA,f.users.full.id,randomUUID(),userMessage,run.assistant_message_id,harness,at]);
 return run;
}

test('actual OpenCode assistant parts retain delivered file attachments',async t=>{
 const f=await platformFixture(t),run=await completedRun(f,'opencode');
 const batch={sourceID:'opencode:fixture',records:[{id:'message:opencode1',runID:run.id,revision:'1',kind:'message',payload:JSON.stringify({id:'opencode1',role:'assistant',parts:[{type:'file',filename:'native.png',mime:'image/png',url:'data:image/png;base64,'+Buffer.from('OpenCode image').toString('base64')}]})}]};
 await f.db.batch(captureNativeBatch(run,batch));
 await f.conversations.onNativeLibraryBatch!(f.users.full!,f.projectA,run.assistant_message_id,batch);
 const items=(await f.request('read','GET',endpoint(f))).json().items;
 assert.equal(items.length,1,'The actual OpenCode parts format must reach Library retention.');
 assert.equal((await f.request('read','GET',items[0].downloadUrl)).body,'OpenCode image');
});

test('actual ACP assistant image chunks recover into retained Library attachments',async t=>{
 const f=await platformFixture(t),run=await completedRun(f,'codex');
 const update={sessionUpdate:'agent_message_chunk',content:{type:'image',mimeType:'image/png',data:Buffer.from('ACP image').toString('base64')}};
 await f.db.batch(await projectNativeUpdate(f.db,run,update,1));
 await f.conversations.onMessageAccepted!(f.users.full!,f.projectA,run.assistant_message_id);
 const items=(await f.request('read','GET',endpoint(f))).json().items;
 assert.equal(items.length,1,'The actual ACP content chunk must reach Library retention.');
 assert.equal((await f.request('read','GET',items[0].downloadUrl)).body,'ACP image');
});

test('purge overlapping an admitted retention cannot recreate purged private bytes',async t=>{
 const f=await platformFixture(t),run=await completedRun(f);
 const original=f.ctx.requireProject.bind(f.ctx);let calls=0;
 f.ctx.requireProject=async(...args:any[])=>{
  const result=await original(...args as Parameters<typeof original>);
  if(++calls===2){
   await f.db.run("UPDATE projects SET status='deleted',purge_after='2020-01-01T00:00:00Z' WHERE id=?",[f.projectA]);
   assert.equal(await purgeExpiredProject(f.ctx,f.projectA),true);
  }
  return result;
 };
 await captureLibraryNativeBatch(f.ctx,f.users.full!,f.projectA,run.assistant_message_id,{records:[{payload:{role:'assistant',content:[{type:'image',data:Buffer.from('private purge race bytes').toString('base64')}]}}]});
 assert.equal(calls>=2,true);
 await assert.rejects(access(join(f.stateDir,'workspace-library',f.projectA)),'Retention must not resurrect storage after permanent purge.');
});

test('actual Pi Durable root attachments survive archive replay without retaining child or tool records',async t=>{
 const f=await platformFixture(t),run=await completedRun(f,'pi');
 const record=(id:string,conversationId:number,kind:string,projection:Record<string,unknown>,bytes:string)=>({
  id,runID:run.id,revision:'1',kind,projectionJSON:JSON.stringify(projection),
  payload:JSON.stringify({type:'entry',conversationId,value:{kind,model:[{role:'assistant',content:[{type:'image',mimeType:'image/png',data:Buffer.from(bytes).toString('base64')}]}]}}),
 });
 const batch={sourceID:'builtin-pi-durable:fixture',records:[
  record('root',1,'pi.assistant',{nativeConversationID:1},'Pi delivered image'),
  record('child',2,'pi.assistant',{nativeConversationID:2,parentNativeConversationID:1,childID:'2'},'PRIVATE CHILD'),
  record('tool',1,'pi.tool',{nativeConversationID:1},'PRIVATE TOOL'),
  record('mismatch',3,'pi.assistant',{nativeConversationID:1},'PRIVATE MISMATCH'),
  {id:'thought',runID:run.id,revision:'1',kind:'agent_thought_chunk',payload:JSON.stringify({sessionUpdate:'agent_thought_chunk',content:{type:'image',data:Buffer.from('PRIVATE THOUGHT').toString('base64')}})},
 ]};
 await f.db.batch(captureNativeBatch(run,batch));
 const items=(await f.request('read','GET',endpoint(f))).json().items;
 assert.equal(items.length,1);
 assert.equal((await f.request('read','GET',items[0].downloadUrl)).body,'Pi delivered image');
});

test('actual native archive paging retains a delivered image larger than inline-record limit',async t=>{
 const f=await platformFixture(t),run=await completedRun(f,'opencode');
 const dir=await mkdtemp('/tmp/wme-review-native-archive-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const archive=await openNativeArchive(join(dir,'archive.jsonl')),bytes=Buffer.alloc(600*1024,65);
 await archive.append([{id:'message:large',runID:run.id,revision:'1',kind:'message',payload:JSON.stringify({id:'large',role:'assistant',parts:[{type:'file',filename:'large.png',mime:'image/png',url:'data:image/png;base64,'+bytes.toString('base64')}]})}]);
 let cursor:any=0,chunked=false;
 for(;;){const page=await archive.page(cursor,200);chunked ||= page.records.some((r:any)=>r.kind==='native-file.chunk');const batch={sourceID:'opencode:fixture',records:page.records};await f.db.batch(captureNativeBatch(run,batch));await f.conversations.onNativeLibraryBatch!(f.users.full!,f.projectA,run.assistant_message_id,batch);cursor=page.nextAfter;if(!page.hasMore)break;}
 assert.equal(chunked,true);
 const items=(await f.request('read','GET',endpoint(f))).json().items;
 assert.equal(items.length,1,'Native archive chunking must not silently discard a normal attachment under the Library 25 MiB cap.');
 assert.deepEqual((await f.request('read','GET',items[0].downloadUrl)).rawPayload,bytes);
});

test('chunked attachment cannot retain tampered bytes and can recover after a missing final chunk arrives',async t=>{
 for(const tamper of [true,false]){
  const f=await platformFixture(t),run=await completedRun(f,'opencode');
  const dir=await mkdtemp('/tmp/wme-review-native-integrity-');t.after(()=>rm(dir,{recursive:true,force:true}));
  const archive=await openNativeArchive(join(dir,'archive.jsonl')),bytes=Buffer.alloc(600*1024,66);
  await archive.append([{id:'message:integrity',runID:run.id,revision:'1',kind:'message',payload:JSON.stringify({id:'integrity',role:'assistant',parts:[{type:'file',filename:'integrity.png',mime:'image/png',url:'data:image/png;base64,'+bytes.toString('base64')}]})}]);
  let cursor:any=0,records:any[]=[];
  for(;;){const page=await archive.page(cursor,200);records.push(...page.records);cursor=page.nextAfter;if(!page.hasMore)break;}
  const index=records.findIndex(r=>r.kind==='native-file.chunk'),original=records[index];assert.ok(index>=0);
  if(tamper){const body=JSON.parse(original.payload),data=Buffer.from(body.dataBase64,'base64');data[0]^=1;records[index]={...original,payload:JSON.stringify({...body,dataBase64:data.toString('base64')})};}
  else records.splice(index,1);
  const batch={sourceID:'opencode:integrity',records};
  await f.db.batch(captureNativeBatch(run,batch));await captureLibraryNativeBatch(f.ctx,f.users.full!,f.projectA,run.assistant_message_id,batch);
  assert.equal((await f.request('read','GET',endpoint(f))).json().items.filter((i:any)=>i.storage==='retained').length,0,'Missing or tampered chunk must not yield retained bytes.');
  if(!tamper){const final={sourceID:batch.sourceID,records:[original]};await f.db.batch(captureNativeBatch(run,final));await captureLibraryNativeBatch(f.ctx,f.users.full!,f.projectA,run.assistant_message_id,final);const items=(await f.request('read','GET',endpoint(f))).json().items.filter((i:any)=>i.storage==='retained');assert.equal(items.length,1,'Durable manifest must recover when its missing chunk arrives.');assert.deepEqual((await f.request('read','GET',items[0].downloadUrl)).rawPayload,bytes);}
 }
});
