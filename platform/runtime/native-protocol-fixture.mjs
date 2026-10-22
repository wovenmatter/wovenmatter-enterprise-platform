// Deterministic ACP peer. This never invokes a provider or loads operator credentials.
import {createInterface} from 'node:readline'
import {appendFileSync} from 'node:fs'
const command = process.argv[2]
if (!['codex-acp','claude-agent-acp','grok'].includes(command)) throw new Error('Wrong native executable')
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n')
const result = (id,value={}) => send({id,result:value})
const sessionId = 'native_fixture'
const configOptions = [
  {id:'model',category:'model',currentValue:command==='claude-agent-acp'?'sonnet':'fixture-model',options:[{value:command==='claude-agent-acp'?'sonnet':'fixture-model',name:'Fixture'}]},
  {id:'thinking',currentValue:'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]},
  {id:'permission_mode',currentValue:'ask',options:[{value:'ask',name:'Ask'},{value:'auto',name:'Auto'}]},
]
let prompt, text
const update = value => send({method:'session/update',params:{sessionId,update:value}})
const finish = () => {
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer'}})
  result(prompt,{stopReason:'end_turn',usage:{totalTokens:37}})
  prompt = undefined
}
createInterface({input:process.stdin}).on('line',line=>{
  const message = JSON.parse(line)
  if(message.jsonrpc!=='2.0')throw new Error('Strict ACP requires JSON-RPC 2.0 on requests, responses and notifications')
  appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify(message)+'\n')
  if(message.method==='initialize')return result(message.id,{protocolVersion:1,_meta:{steering:{supported:process.env.FIXTURE_NO_STEER!=='1'}}})
  if(['session/new','session/load'].includes(message.method)) {
    if(message.params.cwd!==process.cwd())throw new Error('Incorrect native root')
    return result(message.id,{...(message.method==='session/new'?{sessionId}:{}),configOptions})
  }
  if(message.method==='session/set_config_option') {
    configOptions.find(o=>o.id===message.params.configId).currentValue=message.params.value
    return result(message.id,{configOptions})
  }
  if(message.method==='session/prompt') {
    prompt=message.id;text=message.params.prompt[0].text
    if(text==='disconnect')return process.exit(0)
    if(text==='wait'||text==='steer')return
    if(text==='approval')return send({id:'approval',method:'session/request_permission',params:{sessionId,toolCall:{title:'Read fixture'},options:[{optionId:'once',name:'Allow once'}]}})
    return finish()
  }
  if(['_session/steering','_x.ai/interject'].includes(message.method)) {
    if(!prompt)throw new Error('Steering overtook root input')
    result(message.id,{outcome:'injected'});return finish()
  }
  if(message.method==='session/cancel')return result(prompt,{stopReason:'cancelled'})
  if(message.id==='approval') {
    if(message.result.outcome.optionId!=='once')throw new Error('Invalid approval')
    return send({id:'question',method:'elicitation/create',params:{sessionId,mode:'form',message:'Choose fixture output',requestedSchema:{type:'object',properties:{answer:{type:'string',enum:['yes','no']}},required:['answer']}}})
  }
  if(message.id==='question') {
    if(message.result.content.answer!=='yes')throw new Error('Invalid answer')
    return finish()
  }
  send({id:message.id,error:{code:-32601,message:'Unsupported fixture method'}})
})
