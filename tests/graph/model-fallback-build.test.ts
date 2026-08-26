import { describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import {
  PRIMARY_MAX_RETRIES,
  PRIMARY_TIMEOUT_MS,
} from "@/graph/model-fallback";
import type { ResolvedModelConfig } from "@/graph/models";
import type { AgentConfig } from "@/graph/prepare";
import { buildModelAndGraph } from "@/graph/prepare";
import { makeConfig } from "../utils/agent-config";

// WHAT THE FACTORY IS ASKED FOR, which is the half of this feature no behavioural test can see.
//
// The bounds are the design, not a tuning detail: measured live against a real endpoint (issue
// #143), the same 503 turn costs 82.071ms and loses the customer's reply with LangChain's default
// six retries, and 2.563ms with an answer with them capped at one. A fallback built behind the
// default would be a fallback that arrives after the customer has gone — and every test in the
// suite would still be green, because the answer eventually arrives either way.
//
// So this reads the ResolvedModelConfig handed to `createChatModel`, and it reads it on BOTH agents:
// an install that names no fallback has to be handed a config with no bounds at all, or this change
// would have quietly rewritten the retry behaviour of every install that never asked for it.

class Quiet extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType() {
    return "quiet";
  }
  async _generate(): Promise<ChatResult> {
    return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
  }
}

async function configsHandedToTheFactory(
  cfg: AgentConfig,
): Promise<ResolvedModelConfig[]> {
  const seen: ResolvedModelConfig[] = [];
  await buildModelAndGraph(cfg, [], {
    makeModel: (mc: ResolvedModelConfig) => {
      seen.push(mc);
      return new Quiet();
    },
    checkpointer: new MemorySaver(),
  });
  return seen;
}

const FALLBACK = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  credentialRef: "vault:9",
  baseURL: null,
};

describe("what the model factory is asked to build", () => {
  test("with no fallback, the primary carries NO bounds — today's behaviour, untouched", async () => {
    const seen = await configsHandedToTheFactory(makeConfig({}));
    expect(seen).toHaveLength(1);
    // Absent, not zero and not a large number: `models.ts` spreads the field only when it is
    // defined, so absent is the only value that leaves LangChain's own defaults in place.
    expect(seen[0]?.maxRetries).toBeUndefined();
    expect(seen[0]?.timeoutMs).toBeUndefined();
  });

  test("with a fallback, BOTH models get one bounded attempt", async () => {
    const seen = await configsHandedToTheFactory(
      makeConfig({
        modelFallback: FALLBACK,
        modelFallbackApiKey: "sk-fallback",
      }),
    );
    expect(seen).toHaveLength(2);
    for (const mc of seen) {
      expect(mc.maxRetries).toBe(PRIMARY_MAX_RETRIES);
      expect(mc.timeoutMs).toBe(PRIMARY_TIMEOUT_MS);
    }
    // And it is really the OTHER vendor, on its OWN key. A fallback built on the agent's key would
    // send one vendor's secret to another; one built on the agent's provider would be a second
    // attempt against the endpoint that just failed.
    const fb = seen.find((m) => m.provider === "anthropic");
    expect(fb?.model).toBe("claude-haiku-4-5");
    expect(fb?.apiKey).toBe("sk-fallback");
  });

  // The agent's sampling DOES carry, unlike the two sibling overrides, and that is a decision rather
  // than an oversight: the rewrite and the summariser pin their own temperature because they process
  // an answer that already exists, while this one WRITES the answer, in the agent's place. A
  // fallback that replies in a different register than the primary is a worse fallback, and the
  // operator tuned that value for the reply, not for the vendor.
  test("the fallback answers in the agent's register, not a pinned one", async () => {
    const cfg = makeConfig({
      // The default fixture leaves temperature unset, which would let this pass on two undefineds.
      mc: { provider: "openai", model: "gpt-4o-mini", temperature: 0.7 },
      modelFallback: FALLBACK,
      modelFallbackApiKey: "sk-fallback",
    });
    const seen = await configsHandedToTheFactory(cfg);
    const fb = seen.find((m) => m.provider === "anthropic");
    expect(fb?.temperature).toBe(0.7);
  });

  // Every refusal below leaves the install exactly as it is without a fallback, which is the
  // property that makes this safe to ship on. Each is a way an operator can half-configure the block,
  // and none of them may end with the agent's key reaching another vendor.
  test("a fallback whose credential did not resolve builds nothing", async () => {
    const seen = await configsHandedToTheFactory(
      makeConfig({ modelFallback: FALLBACK, modelFallbackApiKey: "" }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxRetries).toBeUndefined();
  });

  test("a fallback with a provider and no model builds nothing", async () => {
    const seen = await configsHandedToTheFactory(
      makeConfig({
        modelFallback: { ...FALLBACK, model: null },
        modelFallbackApiKey: "sk-fallback",
      }),
    );
    expect(seen).toHaveLength(1);
  });

  test("a fallback on an unsupported provider builds nothing", async () => {
    const seen = await configsHandedToTheFactory(
      makeConfig({
        modelFallback: { ...FALLBACK, provider: "not-a-vendor" },
        modelFallbackApiKey: "sk-fallback",
      }),
    );
    expect(seen).toHaveLength(1);
  });

  test("the unavailable line names which refusal it was", async () => {
    const reasons: string[] = [];
    await buildModelAndGraph(
      makeConfig({ modelFallback: FALLBACK, modelFallbackApiKey: "" }),
      [],
      {
        makeModel: () => new Quiet(),
        checkpointer: new MemorySaver(),
        onModelFallbackUnavailable: ({ reason }) => reasons.push(reason),
      },
    );
    expect(reasons).toEqual(["credential_not_found"]);
  });
});
