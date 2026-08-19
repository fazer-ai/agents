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
      provider: "google",
      model: "gemini-3.5-flash",
      apiKey: "test",
      temperature: 0.3,
    }) as unknown as { temperature?: number };
    expect(m.temperature).toBe(0.3);
  });
});

// Anthropic's current generation answers 400 to any non-default `temperature`, and their own
// migration guide says to remove the parameter. The drop is by PROVIDER, not by model pattern:
// claude-haiku-4-5 still accepts it, claude-opus-4-5 accepts it while advertising the same `effort`
// capability as the models that refuse it, and /v1/models never mentions the parameter — so there is
// nothing to match on that will still be true next release. The asymmetry decides it: the guardrail
// pass pins a temperature and is fail-open, so a missed id is not a visible error, it is a
// moderation control that approves everything.
describe("createChatModel temperature on anthropic", () => {
  const anthropic = (model: string, temperature?: number) =>
    createChatModel({
      provider: "anthropic",
      model,
      apiKey: "test",
      temperature,
    }) as ChatAnthropic;

  test("dropped for every model, including the ones that still accept it", () => {
    expect(anthropic("claude-sonnet-5", 0).temperature).toBeUndefined();
    expect(anthropic("claude-opus-5", 0.7).temperature).toBeUndefined();
    expect(anthropic("claude-fable-5", 0.3).temperature).toBeUndefined();
    expect(anthropic("claude-haiku-4-5", 0.3).temperature).toBeUndefined();
  });

  // The two calls the operator cannot reach: both pin 0, and both would fail on every request.
  // The guardrail one is the reason this is a defect rather than an error message.
  test("the pinned internal calls survive the provider", () => {
    expect(anthropic("claude-sonnet-5", 0).temperature).toBeUndefined();
    expect(anthropic("claude-sonnet-5", undefined).temperature).toBeUndefined();
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
