import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError, objectBody, type AppContext } from "../context.js";
export const searchProviders = ["exa","brave","firecrawl"] as const;
type SearchProvider = typeof searchProviders[number];
function provider(value:unknown): SearchProvider {
  if (!searchProviders.includes(value as SearchProvider)) throw new AppError(400,"invalid_search_provider","Choose Exa, Brave, or Firecrawl.");
  return value as SearchProvider;
}
const pathFor=(ctx:AppContext,orgId:string,id:SearchProvider)=>join(ctx.config.stateDir,"control","search-accounts",orgId,id+".json");
export async function searchCredential(ctx:AppContext,orgId:string,id:SearchProvider) {
  try { return JSON.parse(await readFile(pathFor(ctx,orgId,id),"utf8")).key as string; }
  catch(error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return undefined; throw error; }
}
export async function registerSearchAccounts(app:FastifyInstance,ctx:AppContext) {
  const base="/enterprise/api/organizations/:orgId/search-accounts";
  app.get(base,async request=>{
    const user=await ctx.requireUser(request),orgId=(request.params as {orgId:string}).orgId;
    await ctx.requireOrgMember(user,orgId);
    return {items:await Promise.all(searchProviders.map(async id=>({id,configured:Boolean(await searchCredential(ctx,orgId,id))})))};
  });
  app.put(base+"/:provider",async request=>{
    const user=await ctx.requireUser(request),{orgId,provider:id} = request.params as {orgId:string;provider:string};
    await ctx.requireOrgAdmin(user,orgId);
    const selected=provider(id),input=objectBody(request.body);
    if (Object.keys(input).some(key=>key!=="apiKey") || typeof input.apiKey!=="string" || input.apiKey.length<8 || input.apiKey.length>8192 || /[\r\n]/.test(input.apiKey)) throw new AppError(400,"invalid_search_account","Provide an API key with 8–8192 characters.");
    const path=pathFor(ctx,orgId,selected),directory=join(ctx.config.stateDir,"control","search-accounts",orgId);
    await mkdir(directory,{recursive:true,mode:0o700});
    const temp=path+"."+randomUUID()+".tmp";
    await writeFile(temp,JSON.stringify({key:input.apiKey}),{mode:0o600,flag:"wx"});
    await rename(temp,path);
    await ctx.audit(user,orgId,"search.account.updated",selected,{});
    return {id:selected,configured:true};
  });
  app.delete(base+"/:provider",async request=>{
    const user=await ctx.requireUser(request),{orgId,provider:id}=request.params as {orgId:string;provider:string};
    await ctx.requireOrgAdmin(user,orgId);
    const selected=provider(id);
    await unlink(pathFor(ctx,orgId,selected)).catch(error=>{if(error.code!=="ENOENT")throw error;});
    await ctx.audit(user,orgId,"search.account.removed",selected,{});
    return {id:selected,configured:false};
  });
}
/** Ported from desktop default-agent/search.mjs at 07e7bdaa. No provider response bodies enter errors. */
export async function executeSearch(selected:SearchProvider,key:string|undefined,input:Record<string,unknown>,fetcher=fetch) {
  if (!key) throw new AppError(409,"search_account_required","Add the "+selected+" API key in Pi Durable → Accounts → Web search.");
  const read=typeof input.url==="string",limit=Math.min(10,Math.max(1,Math.floor(Number(input.numResults)||5)));
  if (read) {
    let target:URL;
    try { target=new URL(String(input.url)); } catch {throw new AppError(400,"invalid_url","Provide a public HTTP or HTTPS URL.");}
    if (!["http:","https:"].includes(target.protocol) || target.username || target.password) throw new AppError(400,"invalid_url","Provide a public HTTP or HTTPS URL without credentials.");
    if (selected==="brave") throw new AppError(409,"search_read_unavailable","Brave supports search only. Choose Exa or Firecrawl to read webpages.");
  } else if (typeof input.query!=="string" || !input.query.trim() || input.query.length>2000) throw new AppError(400,"invalid_search","Provide a search query.");
  let url:string,headers:Record<string,string>,body:unknown;
  if (selected==="exa") {url="https://api.exa.ai/"+(read?"contents":"search");headers={"x-api-key":key};body=read?{urls:[input.url],text:{maxCharacters:16000}}:{query:input.query,numResults:limit,contents:{text:{maxCharacters:16000}}};}
  else if(selected==="brave"){url="https://api.search.brave.com/res/v1/llm/context";headers={"X-Subscription-Token":key};body={q:input.query,count:limit,maximum_number_of_urls:limit,maximum_number_of_tokens:8192,maximum_number_of_tokens_per_url:4096};}
  else {url="https://api.firecrawl.dev/v2/"+(read?"scrape":"search");headers={Authorization:"Bearer "+key};body=read?{url:input.url,formats:["markdown"]}:{query:input.query,limit,sources:["web"],scrapeOptions:{formats:["markdown"]}};}
  let response:Response,data:any;
  try {
    response=await fetcher(url,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:"error"});
    if (!response.ok) throw new Error("provider failure");
    const text=await response.text();if(Buffer.byteLength(text)>2*1024*1024)throw new Error("oversize");
    data=JSON.parse(text);if(data?.success===false)throw new Error("provider failure");
  } catch {throw new AppError(502,"search_unavailable",selected+" request failed. Check the configured key and available credits.");}
  const results=selected==="exa"?data.results:selected==="brave"?data.grounding?.generic?.map((item:any)=>({...item,text:item.snippets?.join("\n\n")})):read?[{title:data.data?.metadata?.title,url:input.url,text:data.data?.markdown}]:data.data?.web?.map((item:any)=>({...item,text:item.markdown??item.description}));
  return {results:(Array.isArray(results)?results:[]).slice(0,read?1:limit).map(item=>({title:typeof item.title==="string"?item.title.slice(0,1000):undefined,url:typeof item.url==="string"?item.url.slice(0,8192):undefined,text:typeof item.text==="string"?item.text.slice(0,16000):undefined,publishedDate:typeof item.publishedDate==="string"?item.publishedDate.slice(0,100):undefined}))};
}
