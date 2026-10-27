import { AppError, type AppContext, type User } from "../context.js";
import type { Harness } from "../../../../packages/runtime/src/types.js";
import { normalizeConversationTools, type ConversationTools } from "./conversation-tools.js";
import { nativeOptions } from "./native-schema.js";
export type AgentDefaults = { model?: string; thinking?: string; permission?: string; codeMode?: "on"|"only"|"off"; subagentConcurrency?: number; tools?: ConversationTools; models?: string[]; fallbackModels?: string[]; searchProvider?: "exa"|"brave"|"firecrawl" };
export type AgentSettings = {defaultHarness: Harness; agents: Partial<Record<Harness,AgentDefaults>>};
export const harnesses = ["pi","codex","claude_code","grok_build","opencode"] as const;
export function harness(value: unknown): Harness {
  if (!harnesses.includes(value as Harness)) throw new AppError(400,"invalid_native_settings","Choose a supported agent.");
  return value as Harness;
}
export function validateAgentDefaults(id: Harness, value: unknown): AgentDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400,"invalid_native_settings","Provide agent defaults.");
  const input = value as Record<string,unknown>;
  const allowed = ["model","thinking","tools",...(id === "pi" ? ["codeMode","subagentConcurrency","models","fallbackModels","searchProvider"] : ["permission"])];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new AppError(400,"invalid_native_settings","Unknown agent default.");
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length > 240)) throw new AppError(400,"invalid_native_settings","Choose an available model.");
  const result: AgentDefaults = {};
  if (typeof input.model === "string" && input.model) result.model = input.model;
  if (input.thinking !== undefined && input.thinking !== "") {
    if (typeof input.thinking !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.thinking)) throw new AppError(400,"invalid_native_settings","Choose a supported thinking level.");
    result.thinking = input.thinking;
  }
  if (input.tools !== undefined) result.tools = normalizeConversationTools(input.tools);
  if (id !== "pi") Object.assign(result,nativeOptions(Object.fromEntries(["thinking","permission"].filter(key=>input[key]).map(key=>[key,input[key]]))));
  else {
    if (input.codeMode !== undefined && !["on","only","off"].includes(String(input.codeMode))) throw new AppError(400,"invalid_pi_options","Choose a supported code mode.");
    if (input.subagentConcurrency !== undefined && (!Number.isInteger(input.subagentConcurrency) || Number(input.subagentConcurrency)<2 || Number(input.subagentConcurrency)>24)) throw new AppError(400,"invalid_pi_options","Choose 2–24 active subagents.");
    if (input.searchProvider !== undefined && !["exa","brave","firecrawl"].includes(String(input.searchProvider))) throw new AppError(400,"invalid_search_provider","Choose Exa, Brave, or Firecrawl.");
    for (const key of ["models","fallbackModels"] as const) if (input[key] !== undefined) {
      const values = input[key];
      if (!Array.isArray(values) || values.length>500 || values.some(value=>typeof value!=="string" || !value || value.length>240)) throw new AppError(400,"invalid_native_settings","Choose models from the catalog.");
      result[key] = [...new Set(values)] as string[];
    }
    Object.assign(result,Object.fromEntries(["codeMode","subagentConcurrency","searchProvider"].filter(key=>input[key]!==undefined).map(key=>[key,input[key]])));
  }
  return result;
}
export async function organizationAgentSettings(ctx: AppContext, user: User, orgId: string) {
  await ctx.requireOrgMember(user,orgId);
  const row = await ctx.db.get<{settings:string;revision:number}>("SELECT settings,revision FROM organization_agent_settings WHERE org_id=?",[orgId]);
  const stored=JSON.parse(row?.settings??"{}");
  return {defaultHarness:"pi" as Harness,...stored,agents:Object.fromEntries(Object.entries(stored.agents??{}).map(([id,value]:[string,any])=>[id,{...value,...(value.tools?{tools:normalizeConversationTools(value.tools)}:{})}])),revision:row?.revision ?? 0} as AgentSettings & {revision:number};
}
