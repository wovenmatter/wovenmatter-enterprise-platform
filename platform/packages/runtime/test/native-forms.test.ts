import test from "node:test";
import assert from "node:assert/strict";
const {openCodeForm,openCodeFormResponse}=await import(new URL('../src/embedded/native-harnesses/opencode-forms.mjs',import.meta.url).href);
test('OpenCode forms preserve conditional cascading, explicit cleared defaults, custom choices and external acknowledgement',()=>{
  const form={title:'Native form',fields:[
    {key:'enabled',type:'boolean',default:true},
    {key:'details',type:'string',required:true,when:[{key:'enabled',op:'eq',value:true}]},
    {key:'choices',type:'multiselect',custom:true,options:[{value:'listed',label:'Listed'}]},
    {key:'followup',type:'integer',minimum:1,maximum:3,when:[{key:'choices',op:'eq',value:'custom'}]},
    {key:'hidden',type:'string',hidden:true,default:'native default'},
    {key:'amount',type:'integer',default:2},
    {key:'verify',type:'external',url:'https://example.test/verify'},
  ]};
  const answers={enabled:['false'],details:['stale hidden answer'],choices:['listed','custom'],followup:['2'],amount:[],verify:['true']};
  assert.deepEqual(openCodeFormResponse(form,answers),{enabled:false,choices:['listed','custom'],followup:2,hidden:'native default',verify:true});
  assert.equal(openCodeForm(form).questions[5].default[0],'2');
  assert.throws(()=>openCodeFormResponse(form,{...answers,verify:['false']}));
  assert.throws(()=>openCodeFormResponse(form,{...answers,followup:['2.5']}));
  assert.throws(()=>openCodeFormResponse(form,{...answers,followup:['4']}));
  assert.throws(()=>openCodeFormResponse(form,{...answers,enabled:['true'],details:[]}));
});
