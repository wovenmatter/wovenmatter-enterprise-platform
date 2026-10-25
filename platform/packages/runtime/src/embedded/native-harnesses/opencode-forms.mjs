// Port of 04fe0509 OpenCodeFormAnswers / OpenCodeInteractionView. Sequential
// visibility, typed answers, cleared defaults and external acknowledgement are native semantics.
const invalid = () => Object.assign(new Error('The native form response is invalid.'), {code:'native_response_invalid'})
const kinds = ['string','boolean','number','integer','multiselect','external']
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key)
const strings = value => value == null ? [] : Array.isArray(value) ? value.map(String) : [String(value)]
function fields(form) {
  if (!Array.isArray(form.fields) || form.fields.length > 64) throw invalid()
  const keys = new Set()
  for (const field of form.fields) {
    if (!field || typeof field.key !== 'string' || !field.key || keys.has(field.key) || !kinds.includes(field.type) || field.secret || field.format === 'password') throw invalid()
    if (field.when != null && (!Array.isArray(field.when) || field.when.some(c => !keys.has(c.key) || !['eq','neq'].includes(c.op)))) throw invalid()
    if (field.options != null && (!Array.isArray(field.options) || field.options.length > 256 || field.options.some(o => typeof o.value !== 'string'))) throw invalid()
    keys.add(field.key)
  }
  return form.fields
}
export function openCodeForm(form) {
  return {kind:'question',title:form.title??'Agent question',options:[],questions:fields(form).map(field=>({
    id:field.key,prompt:field.title??field.key,type:field.type,description:field.description,
    options:['boolean','external'].includes(field.type)?[{id:'true',label:field.type==='external'?'I have completed this step':'Yes'},{id:'false',label:'No'}]:(field.options??[]).map(o=>({id:o.value,label:o.label??o.value})),
    allowsMultiple:field.type==='multiselect',allowsFreeText:field.custom===true||(['string','number','integer'].includes(field.type)&&!field.options?.length),
    required:field.required===true||field.type==='external',hidden:field.hidden===true,default:strings(field.default),when:field.when??[],
    ...(['http:','https:'].includes(safeProtocol(field.url))?{url:field.url}:{})
  }))}
}
function safeProtocol(url) {try{return new URL(url).protocol}catch{return undefined}}
export function openCodeFormResponse(form, answers = {}) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw invalid()
  const definitions=fields(form), valid=new Set(definitions.map(f=>f.key)), result={}
  if(Object.keys(answers).some(key=>!valid.has(key)))throw invalid()
  for(const field of definitions) {
    if(!(field.when??[]).every(condition=>{
      const answer=result[condition.key]
      if(answer==null)return false
      const matches=Array.isArray(answer)?answer.includes(condition.value):answer===condition.value
      return condition.op==='neq'?!matches:matches
    }))continue
    const chosen=field.hidden?strings(field.default):own(answers,field.key)?answers[field.key]:strings(field.default)
    if(!Array.isArray(chosen)||chosen.some(v=>typeof v!=='string'||v.length>262144)||new Set(chosen).size!==chosen.length||field.type!=='multiselect'&&chosen.length>1)throw invalid()
    let value=field.type==='multiselect'?chosen:chosen[0]??null
    if(['boolean','external'].includes(field.type)) {
      if(value!=null&&!['true','false'].includes(value))throw invalid()
      value=value==='true'
      if(field.type==='external'&&!value)throw invalid()
    }
    if(['number','integer'].includes(field.type)) {
      if(value===''||value==null)value=null
      else {value=Number(value);if(!Number.isFinite(value)||field.type==='integer'&&!Number.isInteger(value)||value<(field.minimum??-Infinity)||value>(field.maximum??Infinity))throw invalid()}
    }
    if(field.required&&(value==null||value===''||Array.isArray(value)&&!value.length))throw invalid()
    if(field.options?.length&&!field.custom&&chosen.some(v=>!field.options.some(o=>o.value===v)))throw invalid()
    if(value!=null)result[field.key]=value
  }
  return result
}
