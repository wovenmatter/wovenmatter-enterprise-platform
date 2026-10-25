// Native-only continuation for a retained synthetic acceptance allocation.
// Does not replace boundary acceptance, alter host policy, or use provider keys.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {ProjectDockerRuntime} from '../dist/packages/runtime/src/project-runtime.js'
if(process.env.WME_RUN_CONTAINER_ACCEPTANCE!=='1')throw Error('Explicit native acceptance required')
const ledger=JSON.parse(await readFile(process.argv[2],'utf8'))
assert.match(ledger.projectId,/^acceptance-[a-f0-9-]{36}$/)
const docker=async(...args)=>(await promisify(execFile)('docker',args,{maxBuffer:4*1024*1024,timeout:90000})).stdout.trim()
const gateway=JSON.parse(await docker('inspect',ledger.gatewayId))[0]
assert.equal(gateway.Config.Labels['com.wovenmatter.enterprise.acceptance'],ledger.allocation)
assert.equal(gateway.State.Running,true)
const files=join(ledger.root,'workspaces'),sessions=join(ledger.root,'sessions'),journal=join(ledger.root,'journal')
const runtime=new ProjectDockerRuntime({image:ledger.image,network:'wme-pr2-acceptance',networkPool:'10.253.240.0/24',gatewayContainer:ledger.gateway,storageRoots:[files],sessionRoot:sessions,journalRoot:journal,gatewayOrigins:['http://api:4100'],egressProxyOrigins:['http://api:4101'],appArmorProfile:'wme-platform-agent'})
const spec={projectId:ledger.projectId,organizationId:'acceptance-org',hostId:'local'}
// Recover only the exact journal-owned fixture allocation; never adopt arbitrary resources.
await runtime.ensureProject(spec)
const results=[]
const selected=process.argv[3]?[process.argv[3]]:['pi','codex','claude_code','grok_build','opencode']
assert.ok(selected.every(h=>['pi','codex','claude_code','grok_build','opencode'].includes(h)))
for(const harness of selected) {
  const conversationId='native-selection-'+harness+'-'+randomUUID().slice(0,8)
  const model=({codex:'gpt-5.4',claude_code:'claude-sonnet-4-6'})[harness]??'synthetic-acceptance-model'
  const input={runId:randomUUID(),conversationId,organizationId:'acceptance-org',projectId:ledger.projectId,generation:0,userId:'synthetic-user',harness,model,access:'write',workingDirectory:'/workspace/.WovenMatter/Acceptance',prompt:'Reply SYNTHETIC_RUNTIME_ACCEPTANCE',pi:{provider:harness==='claude_code'?'anthropic':'openai',api:harness==='claude_code'?'anthropic-messages':'openai-responses',supportsReasoning:true,supportsNativeCompaction:true,codeMode:'off',subagentConcurrency:3,routeIdentity:'synthetic:'+model},mounts:[{source:join(files,'projects',ledger.projectId,'files'),target:'/workspace',access:'write'}],sessionDirectory:join(sessions,'acceptance-org',ledger.projectId,'sessions',conversationId,harness,'write'),gateway:{baseUrl:'http://api:4100/enterprise/api/runtime/inference/'+ledger.projectId,token:'synthetic-scoped-fixture-key'}}
  const run=async(request)=>{
    const events=[]
    await runtime.execute(request,e=>events.push(e),AbortSignal.timeout(60000))
    await writeFile(join(ledger.root,conversationId+'-'+request.generation+'-'+request.runId+'.json'),JSON.stringify(events,null,2),{mode:0o600})
    assert.equal(events.at(-1)?.type,'completed',JSON.stringify(events.filter(e=>['error','failed','interrupted','completed'].includes(e.type))))
    assert.ok(events.some(e=>e.type==='input_accepted'))
    const snapshots=events.filter(e=>e.type==='native_update'&&e.update.sessionUpdate==='agent_message_chunk'&&e.update._meta?.wovenAssistantSnapshot)
    assert.equal(snapshots.length?snapshots.at(-1).update.content.text:events.filter(e=>e.type==='assistant_delta').map(e=>e.delta).join(''),'SYNTHETIC_RUNTIME_ACCEPTANCE')
    return events.find(e=>e.type==='native_session')?.sessionId
  }
  try {
    const id=await run(input);assert.ok(id)
    assert.equal(await run({...input,runId:randomUUID(),resumeId:id}),id)
    await runtime.stopSession(ledger.projectId,conversationId,1)
    assert.equal(await run({...input,runId:randomUUID(),resumeId:id,generation:1}),id)
    results.push({harness,passed:true});console.log(harness+' actual CLI new, warm resume and cold resume passed')
  }catch(error){results.push({harness,passed:false,error:error.message});console.error(harness+' FAILED '+error.message)}
  finally{await runtime.stopSession(ledger.projectId,conversationId,2).catch(()=>{})}
}
await writeFile(join(ledger.root,'native-selection-results.json'),JSON.stringify(results,null,2),{mode:0o600})
assert.equal(results.filter(r=>!r.passed).length,0,JSON.stringify(results))
