import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {restoreLibraryNativeRecord} from "../apps/api/src/workspace-content/library-native.ts";
import type {AppContext} from "../apps/api/src/context.ts";
const {openNativeArchive}=await import(new URL('../packages/runtime/src/embedded/default-agent/src/native-journal.mjs',import.meta.url).href);

async function fixture(t: any, projection: Record<string,unknown> = {}) {
  const dir=await mkdtemp(join(tmpdir(),'wme-library-native-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const content=[{type:'image',data:Buffer.alloc(600*1024,65).toString('base64')}];
  const original={id:'message-record',revision:'v1',runID:'fixture-run',kind:'message',payload:JSON.stringify({role:'assistant',content}),projectionJSON:JSON.stringify({nativeConversationID:'root',...projection,role:'assistant',content})};
  const archive=await openNativeArchive(join(dir,'archive.jsonl'));await archive.append([original]);
  const records:any[]=[];let after:any=0;
  while(true){const page=await archive.page(after,100,1048576);records.push(...page.records);if(!page.hasMore)break;after=page.nextAfter}
  // Production INSERT OR IGNORE deduplicates content-addressed chunks. Repeated
  // byte ranges can have the same chunk ID with different projection offsets.
  const rows=new Map<string,any>();for(const record of records)if(!rows.has(record.id))rows.set(record.id,record);
  let reads=0;
  const ctx={config:{maxFileBytes:25*1024**2},db:{async get(_sql:string,params:any[]){reads++;if(params[0]!=='fixture-run'||params[1]!=='fixture-source')return undefined;const value=rows.get(params[2]);return value?{payload:JSON.stringify(value)}:undefined}}} as unknown as AppContext;
  return {ctx,original,rows,records,manifest:records.find(r=>r.kind==='native-file.manifest'),reads:()=>reads};
}
test('Library reconstructs actual native archive duplicate chunks and rejects changed scope, bytes, offsets and metadata',async t=>{
  const f=await fixture(t),restore=(record:any=f.manifest,source='fixture-source')=>restoreLibraryNativeRecord(f.ctx,'fixture-run',source,record);
  assert.deepEqual(await restore(),f.original);
  assert.equal(await restore(f.manifest,'another-source'),null);
  const first=f.records.find(r=>r.kind==='native-file.chunk'),saved=structuredClone(first),body=JSON.parse(first.payload);
  body.dataBase64='B'+body.dataBase64.slice(1);first.payload=JSON.stringify(body);assert.equal(await restore(),null);f.rows.set(first.id,saved);
  f.rows.delete(first.id);assert.equal(await restore(),null);f.rows.set(first.id,saved);assert.deepEqual(await restore(),f.original);
  for(const change of [(m:any)=>{m.parts[1].byteOffset++},(m:any)=>{m.sha256='0'.repeat(64)},(m:any)=>{m.originalRecord.revision='forged'},(m:any)=>{m.manifestPages=2},(m:any)=>{m.totalBytes=78*1024**2}]){
    const record=structuredClone(f.manifest),payload=JSON.parse(record.payload);change(payload);record.payload=JSON.stringify(payload);f.rows.set(record.id,record);assert.equal(await restore(record),null);f.rows.set(f.manifest.id,f.manifest);
  }
});
test('Library archive prefilter never expands child, tool, raw or oversized records',async t=>{
  const f=await fixture(t,{childID:'private-child'});
  assert.equal(await restoreLibraryNativeRecord(f.ctx,'fixture-run','fixture-source',f.manifest),null);assert.equal(f.reads(),0);
  for(const kind of ['tool','native.raw.record']){
    const record=structuredClone(f.manifest),body=JSON.parse(record.payload);delete body.originalRecord.childID;body.originalRecord.kind=kind;record.payload=JSON.stringify(body);
    assert.equal(await restoreLibraryNativeRecord(f.ctx,'fixture-run','fixture-source',record),null);
  }
  const normal={id:'ordinary',kind:'message'};assert.equal(await restoreLibraryNativeRecord(f.ctx,'fixture-run','fixture-source',normal),normal);
  assert.equal(await restoreLibraryNativeRecord(f.ctx,'fixture-run','fixture-source',f.records[0]),null);
  assert.equal(f.reads(),0);
});
