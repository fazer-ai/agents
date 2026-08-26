import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import {
  BEHAVIOR_SETTINGS_KEYS,
  readBehaviorSettings,
} from "@/modules/agents/behavior-settings";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import {
  readObservabilityConfig,
  storableObservability,
} from "@/modules/flowlog/settings";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";
import { readMemoryConfig } from "@/modules/memory/settings";
import { STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { VISION_PROVIDER_NAMES } from "@/modules/vision/providers";
import { followUpStepFields } from "../utils/followup-step-fields";

// Issue #174. The blocks of `agent_settings_set` were `z.record(z.string(), z.unknown())`, so the
// shape lived in the description and drifted there unwatched: `vision.provider` was published as
// three providers while the registry had five.
//
// The line these tests hold is the one the schema had to be built on. A reader either HONORS a value
// (clamps it, trims it, keeps a legacy spelling) or DISCARDS it (replaces it with a default). The
// schema may refuse the second kind and must still accept the first — copying a clamp into zod turns
// it into a refusal, and the same write would then succeed in the console and fail through MCP.

const patch = z.object(BEHAVIOR_PATCH_SHAPE);

const principal: VerifiedToken = {
  userId: 1n,
  tenantId: 1n,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
};

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "schema-check", version: "0" });
  await client.connect(clientT);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

type JsonSchemaProps = Record<string, Record<string, Record<string, unknown>>>;

// The per-block properties of `agent_settings_set` as `tools/list` publishes them.
async function publishedSchema(): Promise<JsonSchemaProps> {
  const tools = await withClient(async (c) => (await c.listTools()).tools);
  const tool = tools.find((t) => t.name === "agent_settings_set");
  if (!tool) throw new Error("agent_settings_set is not listed");
  const blocks = (tool.inputSchema as { properties: JsonSchemaProps })
    .properties;
  const out: JsonSchemaProps = {};
  for (const [name, block] of Object.entries(blocks)) {
    const props = (block as { properties?: JsonSchemaProps }).properties;
    if (props) out[name] = props;
  }
  return out;
}

// One JSON Schema keyword of one published field. A NULLABLE field is published as
// `anyOf: [<the type>, {"type":"null"}]`, so the keyword sits one level in, and a test that only
// looked at the top would read `undefined` and pass against nothing.
function keywordOf(
  published: JsonSchemaProps,
  block: string,
  name: string,
  keyword: string,
): unknown {
  const f = published[block]?.[name];
  if (!f) throw new Error(`published schema has no ${block}.${name}`);
  const branches = Array.isArray(f.anyOf)
    ? (f.anyOf as Record<string, unknown>[])
    : [f];
  const hit = branches.find((b) => b[keyword] !== undefined);
  if (!hit) {
    throw new Error(`published ${block}.${name} declares no ${keyword}`);
  }
  return hit[keyword];
}

// The blocks `agent_settings_set` exposes. `guardrails` is the one behavior block the tool does not
// take, so the drift check must not demand a schema for it.
const EXPOSED = BEHAVIOR_SETTINGS_KEYS.filter((k) => k !== "guardrails");

// Fields a reader DERIVES rather than stores. Computed from the block's own storable projection, so
// it cannot describe a state the code has left — see the test below it.
const DERIVED = new Set(
  Object.keys(readObservabilityConfig({}))
    .filter((k) => !(k in storableObservability(readObservabilityConfig({}))))
    .map((k) => `observability.${k}`),
);

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
        if (declared.includes(field) || DERIVED.has(`${key}.${field}`))
          continue;
        missing.push(`${key}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // The one field a reader produces that must NOT be declared, and why the exception is COMPUTED
  // rather than written down: `observability.fullDetail` is derived from `fullDetailUntil` on every
  // read (issue #58), so declaring it would let a caller write a value the next read recomputes,
  // and the stored answer and the computed one could then disagree. `storableObservability` is
  // already the single projection every writer of that block goes through, so the difference
  // between what the reader answers and what that projection stores IS the derived set. Written by
  // hand it would go stale the moment the block gains or loses one.
  test("the derived set is exactly what the storable projection drops", () => {
    const read = readObservabilityConfig({});
    const dropped = Object.keys(read).filter(
      (k) => !(k in storableObservability(read)),
    );
    expect(dropped).toEqual(["fullDetail"]);
    expect([...DERIVED]).toEqual(dropped.map((k) => `observability.${k}`));
    // And a derived field must genuinely be absent from the schema, or the exception is hiding a
    // declaration rather than excusing one.
    for (const name of DERIVED) {
      const field = name.split(".")[1] as string;
      expect(
        Object.keys(BEHAVIOR_PATCH_SHAPE.observability.unwrap().shape),
      ).not.toContain(field);
    }
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
    // Compared whole, not by membership: every field of a step is OPTIONAL, so the sweep above,
    // which reads a DEFAULT bag, never sees one of them. The list comes off the interface itself,
    // for the same reason the sweep reads the readers — a field added there and not declared here
    // is a field no caller is ever told about.
    expect(Object.keys(step).sort()).toEqual(followUpStepFields());
  });

  // What the stale prose got wrong, asserted against the registry rather than against a copy of it —
  // and read off the PUBLISHED schema, which is the artifact a client actually receives. Poking at
  // the zod object instead would have missed that `tools/list` drops what it cannot express.
  test("the published choices are the registry's own", async () => {
    const published = await publishedSchema();
    // NOTE: compared as sets. The claim is membership — every provider the build registers is
    // offered, and nothing else is — and the registries are live arrays another test can reorder.
    const choices = (block: string, field: string) =>
      [...(keywordOf(published, block, field, "enum") as string[])].sort();
    expect(choices("stt", "provider")).toEqual([...STT_PROVIDER_NAMES].sort());
    expect(choices("vision", "provider")).toEqual(
      [...VISION_PROVIDER_NAMES].sort(),
    );
    expect(choices("tts", "normalizeProvider")).toEqual(
      [...MODEL_PROVIDERS].sort(),
    );
  });

  // JSON Schema has no regex flags, so an `i` on the reader's pattern is DROPPED on the way out and
  // a client validating against the published pattern refuses what the server accepts. Compiled from
  // the published string, with no flags, because that is what a client would do with it.
  test("the published pattern accepts what the server accepts", async () => {
    const published = await publishedSchema();
    const pattern = keywordOf(published, "stt", "language", "pattern");
    expect(typeof pattern).toBe("string");
    const asClientWouldCompileIt = new RegExp(pattern as string);
    expect(asClientWouldCompileIt.test("pt")).toBe(true);
    expect(asClientWouldCompileIt.test("pt-BR")).toBe(true);
    expect(asClientWouldCompileIt.test("portugues")).toBe(false);
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
    // Zero is a value only where the consumer treats it as one. Here it is the documented way to say
    // OFF, which is why this row and "a zero Chatwoot id" below sit on opposite sides of the line.
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
    ["a language tag with a region", { stt: { language: "pt-BR" } }],
    [
      "null, the way the grounding filter is cleared",
      { grounding: { maxDistance: null } },
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
    // The identifier family. `posInt`/`inboxRef` keep a positive integer and drop everything else, so
    // each of these used to store as null: the pinned target the caller named, silently cleared.
    ["a fractional Chatwoot id", { handoff: { targetAgentId: 1.5 } }],
    ["a zero Chatwoot id", { handoff: { targetTeamId: 0 } }],
    ["a negative Chatwoot id", { handoff: { targetInstanceId: -3 } }],
    ["a fractional inbox id", { channelRedirect: { entryInboxId: 2.5 } }],
    ["a zero widget inbox id", { channelRedirect: { widgetInboxId: 0 } }],
    // Same question, two more readers: a non-positive distance is no filter rather than a nearer
    // one, and a language failing the reader's own pattern comes back as "pt" without saying so.
    ["a non-positive grounding distance", { grounding: { maxDistance: 0 } }],
    [
      "a language that is not a language tag",
      { stt: { language: "portugues" } },
    ],
    // Surrounding whitespace, uniformly. Some of these readers trim before comparing and some test
    // the raw value, and the schema refuses all of them anyway: the trim cannot be PUBLISHED without
    // replacing the enum with a pattern, and a rule the two ends read differently is worse than a
    // narrower one they agree on. See the header, and the parity test below.
    ["a padded provider", { stt: { provider: " openai " } }],
    ["a padded reply mode", { tts: { mode: " mirror " } }],
    ["a padded language tag", { stt: { language: " pt-BR " } }],
    ["a padded handoff mode", { handoff: { mode: " route " } }],
    [
      "a padded delay unit",
      { followUp: { steps: [{ delayUnit: " minutes " }] } },
    ],
    // A model id where a model PROVIDER goes: stored without complaint today, and then
    // resolveNormalizeModel returns `provider_unknown` and the rewrite never runs.
    [
      "a model id in normalizeProvider",
      { tts: { normalizeProvider: "gpt-4o-mini" } },
    ],
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

  // The second constraint, and the one that decided the padding rows above. A client may validate
  // against `tools/list` before sending, so anything the server enforces and the published schema
  // cannot express is a contract the two ends read differently. Leniency added with a `z.preprocess`
  // is exactly that: invisible out there, so the server would accept what a client refuses.
  test("what the schema enforces is what it publishes", async () => {
    expect(patch.safeParse({ stt: { provider: " openai " } }).success).toBe(
      false,
    );
    const choices = keywordOf(
      await publishedSchema(),
      "stt",
      "provider",
      "enum",
    ) as string[];
    expect(choices).toContain("openai");
    expect(choices).not.toContain(" openai ");
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
  const res = (await withClient((c) =>
    c.callTool({ name: "agent_settings_set", arguments: args }),
  )) as { isError?: boolean; content?: { text?: string }[] };
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
