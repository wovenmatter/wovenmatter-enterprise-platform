import test from "node:test";
import assert from "node:assert/strict";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
  modelCapabilities,
  thinkingLevels,
} from "../apps/api/src/inference/capabilities.js";

test("OpenRouter exposes exact efforts, preserves defaults and excludes Off for mandatory models", () => {
  const capabilities = modelCapabilities(
    "openrouter",
    "provider/model",
    {
      reasoning: {
        supported_efforts: ["max", "high", "low", "none"],
        mandatory: true,
        default_effort: "high",
      },
    },
    true,
  );
  assert.deepEqual(capabilities.thinkingLevels, ["low", "high", "max"]);
  assert.equal(capabilities.thinkingLevelMap.off, null);
  assert.equal(capabilities.thinkingLevelMap.medium, null);
  assert.equal(capabilities.defaultThinkingLevel, "high");
});
test("unrestricted and omitted effort metadata have distinct behavior", () => {
  assert.deepEqual(
    modelCapabilities("openrouter", "provider/model", {
      reasoning: { supported_efforts: null },
    }).thinkingLevels,
    [...thinkingLevels],
  );
  assert.deepEqual(
    modelCapabilities("openrouter", "provider/model", {
      reasoning: { mandatory: true },
    }).thinkingLevels,
    [],
  );
  assert.deepEqual(
    modelCapabilities("custom", "provider/model", { supportsReasoning: true })
      .thinkingLevels,
    [],
  );
  assert.deepEqual(
    modelCapabilities("custom", "provider/model", {
      thinking_levels: ["low", "high"],
    }).thinkingLevels,
    ["low", "high"],
  );
});
test("each native provider uses its model's SDK map and does not expose duplicate native aliases", () => {
  for (const provider of ["openai", "anthropic", "xai"] as const) {
    const model = getBuiltinModels(provider).find((m) => m.reasoning);
    assert.ok(model);
    const capabilities = modelCapabilities(provider, model.id);
    const native = getSupportedThinkingLevels(model);
    for (const level of capabilities.thinkingLevels)
      assert.ok(native.includes(level));
    for (const level of thinkingLevels) {
      if (!capabilities.thinkingLevels.includes(level))
        assert.equal(capabilities.thinkingLevelMap[level], null);
    }
    const noReasoning = modelCapabilities(provider, model.id, {
      supports_reasoning: false,
    });
    assert.deepEqual(noReasoning.thinkingLevels, []);
  }
});
test("discovered maps and limits are sanitized and unknown wire settings cannot escape the model contract", () => {
  const capabilities = modelCapabilities("custom", "custom-model", {
    thinkingLevelMap: {
      low: "low",
      high: "high",
      max: "bad\nvalue",
      injected: "high",
    },
    context_length: 65536,
    top_provider: { max_completion_tokens: 8192 },
    architecture: { input_modalities: ["text", "image"] },
  });
  assert.deepEqual(capabilities.thinkingLevels, ["low", "high"]);
  assert.equal(capabilities.thinkingLevelMap.max, null);
  assert.equal(capabilities.contextWindow, 65536);
  assert.equal(capabilities.maxOutputTokens, 8192);
  assert.equal(capabilities.supportsImages, true);
});

test("persisted normalized capabilities preserve native mappings and defaults", () => {
  const first = modelCapabilities("custom", "mapped-model", {
    thinkingLevelMap: { off: "none", low: "light", high: "deep" },
    defaultThinkingLevel: "high",
    contextWindow: 65536,
    maxOutputTokens: 8192,
    supportsImages: true,
    modelCompat: { forceAdaptiveThinking: true },
  });
  const second = modelCapabilities(
    "custom",
    "mapped-model",
    JSON.parse(JSON.stringify(first)),
  );
  assert.deepEqual(second, first);
  assert.equal(second.thinkingLevelMap.low, "light");
  assert.equal(second.thinkingLevelMap.high, "deep");
});

test("adaptive Anthropic implicit minimal maps to Low without an invalid effort alias", () => {
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-6"]) {
    const capabilities = modelCapabilities("anthropic", id);
    assert.equal(capabilities.modelCompat?.forceAdaptiveThinking, true);
    assert.ok(capabilities.thinkingLevels.includes("low"));
    assert.ok(!capabilities.thinkingLevels.includes("minimal"));
    assert.equal(capabilities.thinkingLevelMap.minimal, null);
    assert.equal(capabilities.thinkingLevelMap.low, "low");
    assert.deepEqual(
      modelCapabilities(
        "anthropic",
        id,
        JSON.parse(JSON.stringify(capabilities)),
      ),
      capabilities,
    );
  }
});

test("OpenRouter exact GLM efforts override stale maps and preserve its mandatory Max default", () => {
  const capabilities = modelCapabilities(
    "openrouter",
    "z-ai/glm-5.3-flash",
    {
      thinkingLevelMap: { off: "none", medium: "medium", high: "high" },
      reasoning: {
        mandatory: true,
        default_enabled: true,
        supported_efforts: ["max", "high", "low"],
        default_effort: "max",
      },
    },
    true,
  );
  assert.deepEqual(capabilities.thinkingLevels, ["low", "high", "max"]);
  assert.equal(capabilities.defaultThinkingLevel, "max");
  assert.equal(capabilities.thinkingLevelMap.off, null);
  assert.equal(capabilities.thinkingLevelMap.medium, null);
});

test("public OpenRouter null or omitted reasoning overrides builtin capability guesses", () => {
  const known = getBuiltinModels("openrouter").find((model) => model.reasoning);
  assert.ok(known);
  for (const raw of [{ reasoning: null }, {}]) {
    const capabilities = modelCapabilities("openrouter", known.id, raw, true);
    assert.equal(capabilities.supportsReasoning, false);
    assert.deepEqual(capabilities.thinkingLevels, []);
  }
  assert.equal(
    modelCapabilities("openrouter", known.id, { reasoning: null })
      .supportsReasoning,
    false,
  );
  const defaultOnly = modelCapabilities(
    "openrouter",
    known.id,
    { reasoning: {} },
    true,
  );
  assert.equal(defaultOnly.supportsReasoning, true);
  assert.deepEqual(defaultOnly.thinkingLevels, []);
});

test("OpenRouter disabled-by-default models do not auto-enable their suggested effort", () => {
  const raw = {
    reasoning: {
      supported_efforts: ["high", "low", "none"],
      default_effort: "high",
      default_enabled: false,
    },
  };
  const capabilities = modelCapabilities(
    "openrouter",
    "provider/model",
    raw,
    true,
  );
  assert.deepEqual(capabilities.thinkingLevels, ["off", "low", "high"]);
  assert.equal(capabilities.defaultThinkingLevel, undefined);
  assert.equal(
    modelCapabilities(
      "openrouter",
      "provider/model",
      { ...raw, defaultThinkingLevel: "low" },
      true,
    ).defaultThinkingLevel,
    "low",
  );
});
