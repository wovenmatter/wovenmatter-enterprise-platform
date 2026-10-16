import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { object } from "./proxy-client.js";

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ThinkingMap = Partial<Record<ThinkingLevel, string | null>>;
export type ModelCapabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  thinkingLevelMap: ThinkingMap;
  defaultThinkingLevel?: ThinkingLevel;
  modelCompat?: { forceAdaptiveThinking?: boolean };
};
const level = (value: unknown): ThinkingLevel | undefined =>
  thinkingLevels.includes((value === "none" ? "off" : value) as ThinkingLevel)
    ? ((value === "none" ? "off" : value) as ThinkingLevel)
    : undefined;
const positive = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 10_000_000
    ? value
    : undefined;
const boolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;
const complete = (
  allowed: readonly string[],
  source: ThinkingMap = {},
): ThinkingMap =>
  Object.fromEntries(
    thinkingLevels.map((value) => [
      value,
      allowed.includes(value)
        ? (source[value] ?? (value === "off" ? "none" : value))
        : null,
    ]),
  );

export function modelCapabilities(
  provider: string,
  id: string,
  raw: unknown = {},
  fromCatalog = false,
): ModelCapabilities {
  const item = object(raw),
    reasoning = object(item.reasoning),
    caps = object(item.capabilities);
  const hasReasoningMetadata =
    item.reasoning !== null &&
    typeof item.reasoning === "object" &&
    !Array.isArray(item.reasoning);
  const builtin = ["openai", "anthropic", "xai", "openrouter"].includes(
    provider,
  )
    ? getBuiltinModels(
        provider as "openai" | "anthropic" | "xai" | "openrouter",
      ).find((model) => model.id === id)
    : undefined;
  const suppliedMap = object(item.thinkingLevelMap ?? item.thinking_level_map);
  let map: ThinkingMap, allowed: ThinkingLevel[];
  const efforts = Object.hasOwn(reasoning, "supported_efforts")
    ? reasoning.supported_efforts
    : (item.thinkingLevels ?? item.thinking_levels);
  const hasEfforts =
    Array.isArray(efforts) || reasoning.supported_efforts === null;
  const exactEfforts =
    Object.hasOwn(reasoning, "supported_efforts") && hasEfforts;
  if (exactEfforts) {
    allowed =
      efforts === null
        ? [...thinkingLevels]
        : [
            ...new Set(
              (efforts as unknown[])
                .map(level)
                .filter((v): v is ThinkingLevel => v !== undefined),
            ),
          ];
    map = complete(allowed);
  } else if (Object.keys(suppliedMap).length) {
    map = Object.fromEntries(
      thinkingLevels.map((value) => {
        const wire = suppliedMap[value];
        return [
          value,
          wire === null ||
          typeof wire !== "string" ||
          !wire ||
          wire.length > 64 ||
          /[\r\n\x00]/.test(wire)
            ? null
            : wire,
        ];
      }),
    );
    allowed = thinkingLevels.filter((value) => map[value] != null);
    if (Array.isArray(efforts)) {
      const advertised = efforts.map(level);
      allowed = allowed.filter((value) => advertised.includes(value));
      map = complete(allowed, map);
    }
  } else if (hasEfforts) {
    allowed = [
      ...new Set(
        (efforts as unknown[])
          .map(level)
          .filter((v): v is ThinkingLevel => v !== undefined),
      ),
    ];
    map = complete(allowed);
  } else if (hasReasoningMetadata) {
    // An omitted supported_efforts field means the provider offers no effort selector.
    allowed = [];
    map = complete([]);
  } else if (builtin) {
    allowed = builtin.reasoning ? getSupportedThinkingLevels(builtin) : [];
    const nativeMap = { ...builtin.thinkingLevelMap };
    // Pi translates the implicit adaptive Anthropic minimal alias to low.
    // Completing the map before this translation would invent a wire effort.
    if (
      provider === "anthropic" &&
      object(builtin.compat).forceAdaptiveThinking === true &&
      nativeMap.minimal === undefined
    )
      nativeMap.minimal = "low";
    map = complete(allowed, nativeMap);
    // Do not present separate aliases for a provider's identical native setting.
    allowed = allowed.filter((value) => {
      const wire = map[value];
      return (
        wire === value ||
        (wire === "none" && value === "off") ||
        !allowed.some(
          (other) => other !== value && other === wire && map[other] === wire,
        )
      );
    });
    map = complete(allowed, map);
  } else {
    allowed = [];
    map = complete([]);
  }
  if (reasoning.mandatory === true) {
    allowed = allowed.filter((value) => value !== "off");
    map.off = null;
  }
  const explicitReasoning = boolean(
    item.supports_reasoning ??
      item.supportsReasoning ??
      caps.reasoning ??
      (typeof item.reasoning === "boolean" ? item.reasoning : undefined),
  );
  const supportsReasoning =
    provider === "openrouter" &&
    (item.reasoning === null ||
      (fromCatalog && !Object.hasOwn(item, "reasoning")))
      ? false
      : (explicitReasoning ??
        (hasReasoningMetadata ||
          builtin?.reasoning === true ||
          allowed.some((value) => value !== "off")));
  if (!supportsReasoning) {
    allowed = [];
    map = complete([]);
  }
  const rawDefault = level(
    item.defaultThinkingLevel ??
      item.default_thinking_level ??
      (reasoning.default_enabled === false
        ? undefined
        : reasoning.default_effort),
  );
  const defaultThinkingLevel =
    rawDefault && allowed.includes(rawDefault) ? rawDefault : undefined;
  const modalities =
    object(item.architecture).input_modalities ?? item.input_modalities;
  const forceAdaptiveThinking = boolean(
    object(item.modelCompat ?? item.compat).forceAdaptiveThinking ??
      object(builtin?.compat).forceAdaptiveThinking,
  );
  return {
    contextWindow:
      positive(
        item.context_window ??
          item.contextWindow ??
          item.context_length ??
          item.contextLength,
      ) ?? builtin?.contextWindow,
    maxOutputTokens:
      positive(
        item.max_output_tokens ??
          item.maxOutputTokens ??
          item.max_tokens ??
          item.maxTokens ??
          object(item.top_provider).max_completion_tokens,
      ) ?? builtin?.maxTokens,
    supportsImages:
      boolean(
        item.supports_images ??
          item.supportsImages ??
          caps.images ??
          caps.vision,
      ) ??
      (Array.isArray(modalities)
        ? modalities.includes("image")
        : builtin?.input.includes("image")),
    supportsReasoning,
    thinkingLevels: thinkingLevels.filter((value) => allowed.includes(value)),
    thinkingLevelMap: map,
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
    ...(forceAdaptiveThinking === undefined
      ? {}
      : { modelCompat: { forceAdaptiveThinking } }),
  };
}

/** Public metadata only: no user key, account identifier, or prompt is sent. */
export async function openRouterModelCatalog(
  fetcher: typeof fetch,
): Promise<Map<string, Record<string, unknown>>> {
  const response = await fetcher("https://openrouter.ai/api/v1/models", {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Model metadata unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model metadata unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Model metadata too large");
    }
    chunks.push(next.value);
  }
  const data = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data;
  if (!Array.isArray(data) || data.length > 5000)
    throw new Error("Invalid model metadata");
  return new Map(
    data
      .map(object)
      .filter((item) => typeof item.id === "string")
      .map((item) => [String(item.id), item]),
  );
}
