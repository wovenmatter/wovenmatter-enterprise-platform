import piLogo from "./assets/pi-durable.svg";
import codexLogo from "./assets/codex.png";
import claudeLogo from "./assets/claude.svg";
import grokLogo from "./assets/grok.svg";
import opencodeLogo from "./assets/opencode.svg";
const logos: Record<string, string> = { pi: piLogo, codex: codexLogo, claude_code: claudeLogo, grok_build: grokLogo, opencode: opencodeLogo };
export function agentLogo(id: string) { return logos[id] ?? piLogo; }
/** Runtime identifiers and presentation names from WovenMatter 04fe0509. */
export const agents = [
  { id: "pi", name: "Pi Durable", mark: "π", detail: "Durable sessions with code tools and subagents." },
  { id: "codex", name: "Codex", mark: "◉", detail: "OpenAI coding agent with native approvals." },
  { id: "claude_code", name: "Claude Code", mark: "✳", detail: "Anthropic coding agent with native permissions." },
  { id: "grok_build", name: "Grok Build", mark: "𝕏", detail: "xAI coding agent with native execution controls." },
  { id: "opencode", name: "OpenCode", mark: "▣", detail: "OpenCode sessions with native questions and approvals." },
] as const;
export function agentName(id?: string) { return agents.find(a => a.id === id)?.name ?? id ?? "Pi Durable"; }

// The scoped organization proxy translates each agent's native wire protocol.
export function acceptsModel(_harness: string, _provider: string) { return true; }
