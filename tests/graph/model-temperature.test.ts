import { describe, expect, test } from "bun:test";
import type { ChatAnthropic } from "@langchain/anthropic";
import type { ChatOpenAI } from "@langchain/openai";
import { createChatModel } from "@/graph/models";

// OpenAI's reasoning families answer 400 ("Unsupported value: 'temperature' does not support 0.3
// with this model") to ANY temperature but the default, which kills the call outright — the agent
// turn, the guardrail pass and the TTS speech normalization all pin one. The factory must drop the
// parameter for those models and keep it for everything else.
describe("createChatModel temperature on reasoning models", () => {
  const openai = (model: string, temperature?: number) =>
    createChatModel({
      provider: "openai",
      model,
      apiKey: "test",
      temperature,
    }) as ChatOpenAI;

  test("dropped for the o-series", () => {
    expect(openai("o4-mini", 0.3).temperature).toBeUndefined();
    expect(openai("o1", 0.3).temperature).toBeUndefined();
    expect(openai("o3-mini", 0).temperature).toBeUndefined();
  });

  test("dropped for the gpt-5 family", () => {
    expect(openai("gpt-5", 0.3).temperature).toBeUndefined();
    expect(openai("gpt-5-mini", 0.3).temperature).toBeUndefined();
    expect(openai("gpt-5.4-mini", 0.7).temperature).toBeUndefined();
  });

  // NOTE: gpt-5-chat* is the non-reasoning chat family and accepts `temperature` (the
  // @langchain/openai isReasoningModel predicate carries the same exemption); dropping it there
  // silently discards the operator's preference instead of preventing a 400.
  test("kept for gpt-5-chat (non-reasoning chat family)", () => {
    expect(openai("gpt-5-chat-latest", 0.3).temperature).toBe(0.3);
    expect(openai("gpt-5-chat", 0.7).temperature).toBe(0.7);
    const routed = createChatModel({
      provider: "openrouter",
      model: "openai/gpt-5-chat",
      apiKey: "test",
      temperature: 0.3,
    }) as ChatOpenAI;
    expect(routed.temperature).toBe(0.3);
  });

  test("kept for models that accept it", () => {
    expect(openai("gpt-4o", 0.3).temperature).toBe(0.3);
    expect(openai("gpt-4.1-mini", 0).temperature).toBe(0);
    // "omni-…" must not be mistaken for the o-series.
    expect(openai("omni-moderation-latest", 0.3).temperature).toBe(0.3);
  });

  test("dropped for a routed OpenRouter id", () => {
    const m = createChatModel({
      provider: "openrouter",
      model: "openai/o4-mini",
      apiKey: "test",
      temperature: 0.3,
    }) as ChatOpenAI;
    expect(m.temperature).toBeUndefined();
  });

  test("openai-compatible keeps temperature for a normal model", () => {
    const m = createChatModel({
      provider: "openai-compatible",
      model: "llama-3.1-8b",
      apiKey: "test",
      baseURL: "https://llm.example.com/v1",
      temperature: 0.3,
    }) as ChatOpenAI;
    expect(m.temperature).toBe(0.3);
  });

  test("non-OpenAI providers are untouched", () => {
    const m = createChatModel({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: "test",
      temperature: 0.3,
    }) as ChatAnthropic;
    expect(m.temperature).toBe(0.3);
  });
});

// A fine-tuned model inherits its base model's parameter rules, and OpenAI spells those ids
// "ft:<base>:<org>:<name>:<id>". The prefix hid the base from this rule, so a fine-tune of a
// reasoning model kept a temperature the base rejects — and DEFAULT_MODEL_CONFIG ships
// temperature 0.7, so the default agent was the broken case rather than an exotic one.
describe("createChatModel temperature on fine-tuned ids", () => {
  const openai = (model: string, temperature?: number) =>
    createChatModel({
      provider: "openai",
      model,
      apiKey: "test",
      temperature,
    }) as ChatOpenAI;

  test("dropped when the base model reasons", () => {
    expect(openai("ft:gpt-5.6-luna:acme::x1", 0.7).temperature).toBeUndefined();
    expect(openai("ft:o4-mini:acme::x1", 0.3).temperature).toBeUndefined();
  });

  test("kept when the base model does not", () => {
    expect(openai("ft:gpt-4o:acme::x1", 0.3).temperature).toBe(0.3);
    expect(openai("ft:gpt-5-chat:acme::x1", 0.3).temperature).toBe(0.3);
  });
});
