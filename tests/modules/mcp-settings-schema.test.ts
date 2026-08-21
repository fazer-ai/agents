import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  BEHAVIOR_SETTINGS_KEYS,
  readBehaviorSettings,
} from "@/modules/agents/behavior-settings";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { readObservabilityConfig } from "@/modules/flowlog/settings";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";
import { readMemoryConfig } from "@/modules/memory/settings";
import { STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { VISION_PROVIDER_NAMES } from "@/modules/vision/providers";

// Issue #174. The blocks of `agent_settings_set` were `z.record(z.string(), z.unknown())`, so the
// shape lived in the description and drifted there unwatched: `vision.provider` was published as
// three providers while the registry had five.
//
// The line these tests hold is the one the schema had to be built on. A reader either HONORS a value
// (clamps it, trims it, keeps a legacy spelling) or DISCARDS it (replaces it with a default). The
// schema may refuse the second kind and must still accept the first — copying a clamp into zod turns
// it into a refusal, and the same write would then succeed in the console and fail through MCP.

const patch = z.object(BEHAVIOR_PATCH_SHAPE);

// The blocks `agent_settings_set` exposes. `guardrails` is the one behavior block the tool does not
// take, so the drift check must not demand a schema for it.
const EXPOSED = BEHAVIOR_SETTINGS_KEYS.filter((k) => k !== "guardrails");

describe("agent_settings_set argument schema", () => {
  test("every block the tool exposes is declared", () => {
    expect(Object.keys(BEHAVIOR_PATCH_SHAPE).sort()).toEqual(
      [...EXPOSED].sort(),
    );
  });

  // The drift check, and the reason this file exists. A field added to a reader without being
  // declared here is a field a client is never told about — which is the state the whole tool was
  // in. Read off the readers themselves, so it cannot go stale the way a list in prose did.
  test("every field the readers produce is declared", () => {
    const produced = readBehaviorSettings({}) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const missing: string[] = [];
    for (const key of EXPOSED) {
      const declared = Object.keys(BEHAVIOR_PATCH_SHAPE[key].unwrap().shape);
      for (const field of Object.keys(produced[key] ?? {})) {
        if (!declared.includes(field)) missing.push(`${key}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // The two nested shapes the loop above only sees the top of.
  test("the nested shapes are declared too", () => {
    const compaction = BEHAVIOR_PATCH_SHAPE.memory
      .unwrap()
      .shape.compaction.unwrap();
    expect(Object.keys(compaction.shape)).toEqual(
      Object.keys(readMemoryConfig({}).compaction),
    );
    const step = BEHAVIOR_PATCH_SHAPE.followUp.unwrap().shape.steps.unwrap()
      .element.shape;
    expect(Object.keys(step)).toContain("delayValue");
    expect(Object.keys(step)).toContain("assignLabels");
  });

  // What the stale prose got wrong, asserted against the registry rather than against a copy of it.
  test("the published choices are the registry's own", () => {
    const providerOf = (block: "stt" | "vision") =>
      BEHAVIOR_PATCH_SHAPE[block].unwrap().shape.provider.unwrap().options;
    expect(providerOf("stt")).toEqual(STT_PROVIDER_NAMES);
    expect(providerOf("vision")).toEqual(VISION_PROVIDER_NAMES);
  });

  // A value the readers HONOR has to parse. Each row is a real reader behavior, not a hypothetical:
  // the number is clamped, the text is capped only when the write changes it, the list is truncated,
  // the undeclared key is merged and then normalized away.
  const honored: [string, Record<string, unknown>][] = [
    [
      "a number past its ceiling (clamped to 120)",
      { debounce: { windowSeconds: 9999 } },
    ],
    ["a number under its floor (clamped to 80)", { split: { maxChars: 1 } }],
    [
      "zero, which means OFF for the history ceiling",
      { limits: { maxHistoryTokens: 0 } },
    ],
    ["null, which also means OFF", { limits: { maxHistoryTokens: null } }],
    ["a voice knob past its band (clamped to 4)", { tts: { speed: 9 } }],
    [
      "operator text over its cap (refused only when the write CHANGES it)",
      { handoff: { instructions: "x".repeat(2_000) } },
    ],
    [
      "a step instruction over its cap",
      { followUp: { steps: [{ instructions: "x".repeat(3_000) }] } },
    ],
    [
      "more attribute keys than the reader keeps",
      {
        attributeContext: {
          conversation: Array.from({ length: 50 }, (_, i) => `k${i}`),
        },
      },
    ],
    [
      "a host string the normalizer will drop",
      { sendImage: { allowedHosts: ["not a host"] } },
    ],
    [
      "a language the reader will fall back on",
      { stt: { language: "not-a-language" } },
    ],
    [
      "a distance the reader reads as no filter",
      { grounding: { maxDistance: -1 } },
    ],
    // The blocks are loose on purpose: an undeclared key still reaches the readers, so a field added
    // to a reader by someone who never opened the schema is merged rather than dropped on the way in.
    ["a key no one declared", { tts: { someFutureKnob: true } }],
    [
      "the legacy single-label spelling",
      { followUp: { steps: [{ assignLabel: "lead" }] } },
    ],
  ];

  test.each(honored)("honored: %s", (_label, value) => {
    const parsed = patch.safeParse(value);
    expect(parsed.success).toBe(true);
  });

  // What the readers DISCARD may be refused, and refusing it is the point: today the call succeeds
  // and stores a default nobody asked for.
  const discarded: [string, Record<string, unknown>][] = [
    ["a boolean spelled as a word", { debounce: { enabled: "yes" } }],
    ["a provider that is not registered", { stt: { provider: "whisper" } }],
    ["a reply mode that does not exist", { tts: { mode: "always" } }],
    [
      "a delay unit that does not exist",
      { followUp: { steps: [{ delayUnit: "weeks" }] } },
    ],
    ["a handoff mode that does not exist", { handoff: { mode: "escalate" } }],
    [
      "a redirect delay unit that does not exist",
      { channelRedirect: { resendDelayUnit: "months" } },
    ],
    ["a number sent as a string", { limits: { maxToolCalls: "10" } }],
    [
      "a host list sent as one string",
      { sendImage: { allowedHosts: "loja.com.br" } },
    ],
    [
      "attribute keys that are not strings",
      { attributeContext: { conversation: [1, 2] } },
    ],
    ["a block sent as an array", { debounce: [] }],
  ];

  test.each(discarded)("refused: %s", (_label, value) => {
    expect(patch.safeParse(value).success).toBe(false);
  });

  // The named exception. The string spellings are a defense for what is already STORED, and that
  // half is untouched — what narrows is only what a caller may newly send.
  test("the string spelling of a boolean stays readable and stops being writable", () => {
    expect(
      readObservabilityConfig({ observability: { logToolValues: "true" } })
        .logToolValues,
    ).toBe(true);
    expect(
      readMemoryConfig({ memory: { compaction: { enabled: "false" } } })
        .compaction.enabled,
    ).toBe(false);
    expect(
      patch.safeParse({ observability: { logToolValues: "true" } }).success,
    ).toBe(false);
    expect(
      patch.safeParse({ memory: { compaction: { enabled: "false" } } }).success,
    ).toBe(false);
  });

  // `success: true` is not enough for the two rows above: a strict object would STRIP the undeclared
  // key and still parse, which is the worse outcome of the three — the write silently does not
  // happen. What the loose object buys is that the key comes out the other side.
  test("an undeclared key survives the parse, rather than being stripped", () => {
    const parsed = patch.parse({
      tts: { mode: "mirror", someFutureKnob: true },
    });
    expect(parsed.tts).toEqual({ mode: "mirror", someFutureKnob: true });
  });

  test("the legacy single-label spelling survives the parse", () => {
    const parsed = patch.parse({
      followUp: { steps: [{ assignLabel: "lead" }] },
    });
    expect((parsed.followUp as { steps: unknown[] }).steps[0]).toEqual({
      assignLabel: "lead",
    });
  });

  // The partial-patch contract, at the parse boundary. zod 4 omits an absent optional rather than
  // materializing it as `undefined`; if that ever changed, every sibling of a one-knob patch would
  // be spread over the stored block as undefined and the merge would wipe them.
  test("a one-field patch parses to exactly that field", () => {
    const parsed = patch.parse({ tts: { mode: "mirror" } });
    expect(Object.keys(parsed)).toEqual(["tts"]);
    expect(Object.keys(parsed.tts as object)).toEqual(["mode"]);
  });
});

// Through a real MCP client, because the parse that refuses a call happens in the SDK, one layer
// ABOVE every test that calls `agentSettingsSet` directly. Nothing here reaches a database: the
// suite's preload points DATABASE_URL at a dead host on purpose, and that is what makes the two
// outcomes below tell each other apart — a call refused at the boundary never gets far enough to
// find out the database is unreachable.
async function callSettingsSet(
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const principal: VerifiedToken = {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "schema-check", version: "0" });
  await client.connect(clientT);
  const res = (await client.callTool({
    name: "agent_settings_set",
    arguments: args,
  })) as { isError?: boolean; content?: { text?: string }[] };
  await client.close();
  return {
    isError: res.isError === true,
    text: res.content?.[0]?.text ?? "",
  };
}

describe("agent_settings_set over MCP", () => {
  test("a value outside the choices is refused, naming the field and the options", async () => {
    const r = await callSettingsSet({
      agent_id: "1",
      tts: { mode: "always" },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("tts.mode");
    expect(r.text).toContain("never");
    expect(r.text).toContain("preference");
  });

  test("a clamped value is NOT refused, it goes through to the readers", async () => {
    const r = await callSettingsSet({
      agent_id: "1",
      debounce: { windowSeconds: 9999 },
    });
    // It fails on the unreachable database, which is the proof: the argument passed validation and
    // the handler ran. A bound copied into the schema would have stopped it one layer earlier.
    expect(r.text).not.toContain("Invalid arguments");
  });
});
