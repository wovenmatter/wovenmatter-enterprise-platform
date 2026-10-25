const before = message => Object.assign(new Error(message), { beforePrompt:true })
const values = options => (options ?? []).flatMap(o => o.value == null ? values(o.options) : [o.value])
const delay = ms => new Promise(done => setTimeout(done,ms))

// Apply advertised native options. An unavailable product permission default
// inherits native policy; explicit saved choices still fail before submission.
export async function applyTaskConfiguration(rpc, sessionID, initial, configuration) {
  let current = initial
  for (const [category,wanted] of [['model',configuration.model],['thinking',configuration.thinking],['permission',configuration.permission]]) {
    if (!wanted) continue
    if (category === 'permission' && configuration.runtimeKind === 'grok_build') continue // explicit CLI policy
    const option = (current.configOptions ?? []).find(o => category === 'model' ? o.id === 'model' || o.category === 'model'
      : category === 'thinking' ? ['effort','reasoning_effort','thinking'].includes(o.id) || o.category === 'thought_level'
        : ['permission_mode','approval_mode'].includes(o.id) || (o.id === 'mode' && ['codex','claude_code'].includes(configuration.runtimeKind)))
    if (category === 'permission' && configuration.usesProductPermissionDefault === true
      && !(option ? values(option.options).includes(wanted) : current.modes?.availableModes?.some(mode => mode.id === wanted))) continue
    if (option) {
      if (!values(option.options).includes(wanted)) throw before(`The saved ${category} is no longer available.`)
      if (option.currentValue !== wanted) {
        const result = await rpc('session/set_config_option',{sessionId:sessionID,configId:option.id,value:wanted})
        current = { ...current,...result }
        if (result?.configOptions?.find(x=>x.id===option.id)?.currentValue !== wanted) throw before(`The agent did not confirm the saved ${category}.`)
      }
    } else if (category === 'model' && current.models?.availableModels?.some(x=>x.modelId===wanted)) {
      if (current.models.currentModelId !== wanted) await rpc('session/set_model',{sessionId:sessionID,modelId:wanted})
    } else if (category === 'permission' && current.modes?.availableModes?.some(x=>x.id===wanted)) {
      if (current.modes.currentModeId !== wanted) await rpc('session/set_mode',{sessionId:sessionID,modeId:wanted})
    } else throw before(`This agent cannot apply the task's saved ${category}.`)
  }
}
