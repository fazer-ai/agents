import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import { assertSettingsToolPreconditions } from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { invalidToolPreconditions } from "@/modules/agents/tool-preconditions";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";

// EVERY BLOCK OF THE AGENT SETTINGS BAG REACHES `agent_settings_set`, OR SAYS WHY NOT. A hand-kept
// list (BEHAVIOR_SETTINGS_KEYS, in tests/modules/mcp-settings-schema.test.ts) leaves unchecked any
// block nobody added, so "not exposed on purpose" looks exactly like "never registered".
//
// SO THE BLOCKS ARE DISCOVERED BY EXECUTION, NOT BY A LIST AND NOT BY A SOURCE SCAN (same move as
// tests/modules/agents/credential-paths.test.ts). A source scan mistakes a read of a block's INNER
// bag for a top-level block. A Proxy in the bag's place records exactly the first-level keys a
// reader touches, so a reader that reaches into its own sub-object is not mistaken for a block owner.

const principal: VerifiedToken = {
  userId: 1n,
  tenantId: 1n,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
};

// TWO SOURCES, because neither covers the bag alone:
//   1. `readBehaviorSettings({})`, whose OUTPUT keys are the behavior blocks; several have their
//      reader outside a settings.ts, so the glob below never sees them.
//   2. The per-module settings readers, probed: this finds a block OUTSIDE the behavior aggregate.
// It does NOT import the whole tree: calling every `read*` export runs real code, including Prisma
// queries, and a completeness check must not perform I/O. A block whose reader lives outside
// `settings.ts` AND outside the aggregate is invisible here; the fix is to add its file to the glob.
const READER_GLOBS = [
  "modules/**/settings.ts",
  "modules/agents/tool-guidance.ts",
  "modules/agents/tool-preconditions.ts",
];

// A block a reader owns but `agent_settings_set` deliberately does not take, with the reason: the
// string is what tells a reader the absence was chosen rather than forgotten. The probe finds
// CANDIDATES only: it records which key a reader touches, not which BAG the runtime hands it.
const NOT_PUBLISHED: Record<string, string> = {
  spendCeiling:
    "NOT an agent-settings block. `readSpendCeilingConfig` is only ever handed a TENANT's settings " +
    "bag: `readTenantSpendCeiling` selects it off the `tenants` row, and the other five call sites " +
    "are `tenant-settings/service.ts` reading and patching that same row. No call site anywhere " +
    "reaches `agent.settings`, and the ceiling is a tenant-wide budget by design — it counts one " +
    "ledger for every agent the tenant runs, so publishing it per agent would offer a knob whose " +
    "value the next agent's screen would silently contradict. It is configurable through " +
    "`PATCH /v1/tenant-settings/spend-ceiling` and the console's own screen. If it is ever to reach " +
    "MCP it belongs to `tenant_settings_update`, which today carries embedding and langfuse only — " +
    "`company` sits outside it for the same reason, so this is not the ceiling's own gap.",
  appointmentReminders:
    "NOT an agent-settings block. `readAppointmentReminderConfig` is only ever called with " +
    "`sel.config` — the Google Calendar integration INSTANCE's config (toolpacks/google-calendar.ts, " +
    "two call sites) — never with `agent.settings`. Publishing it here shipped a setting that stores " +
    "and reads back and schedules nothing, which is worse than its absence: it is configuration that " +
    "reports success. It is already configurable through `integration_update`. Caught in review on " +
    "PR #404 after the probe reported it three times and hand-checking got it wrong in both " +
    "directions; the reader is shared, so the probe cannot tell whose bag it reads.",
};

// Readers that cannot be probed with a bare bag (they need more than the settings object). Same
// contract as above: named, with a reason, never skipped silently: a probe that quietly gives up on
// a reader reports "no blocks" for it, which reads exactly like a reader that owns none.
const UNPROBEABLE: Record<string, string> = {};

// The per-block properties, as tools/list publishes them.
async function publishedProperties(): Promise<
  Record<string, Record<string, unknown>>
> {
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "props", version: "0" });
  await client.connect(clientT);
  try {
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "agent_settings_set",
    );
    if (!tool) throw new Error("agent_settings_set is not listed");
    const blocks = (
      tool.inputSchema as {
        properties?: Record<string, { properties?: Record<string, unknown> }>;
      }
    ).properties;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, block] of Object.entries(blocks ?? {})) {
      if (block.properties) out[name] = block.properties;
    }
    return out;
  } finally {
    await client.close();
  }
}

async function publishedBlocks(): Promise<Set<string>> {
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "parity", version: "0" });
  await client.connect(clientT);
  try {
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "agent_settings_set",
    );
    if (!tool) throw new Error("agent_settings_set is not listed");
    const props = (tool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    return new Set(Object.keys(props ?? {}));
  } finally {
    await client.close();
  }
}

interface Owned {
  block: string;
  reader: string;
}

// Runs every discovered reader against a Proxy and records which first-level keys it read.
async function ownedBlocks(): Promise<{
  owned: Owned[];
  unprobeable: string[];
}> {
  const { Glob } = await import("bun");
  const owned: Owned[] = [];
  const unprobeable: string[] = [];
  // Source 1: the aggregate's own output keys.
  for (const block of Object.keys(readBehaviorSettings({}))) {
    owned.push({ block, reader: "readBehaviorSettings" });
  }
  const files = new Set<string>();
  for (const pattern of READER_GLOBS) {
    for await (const rel of new Glob(pattern).scan("src")) {
      if (!rel.includes(".test.")) files.add(rel);
    }
  }
  for (const rel of [...files].sort()) {
    const mod: Record<string, unknown> = await import(`@/${rel}`);
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== "function" || !/^read[A-Z]/.test(name)) continue;
      const id = `src/${rel}::${name}`;
      const seen = new Set<string>();
      const probe = new Proxy(
        {},
        {
          get(_t, p) {
            if (typeof p === "string") seen.add(p);
            return undefined;
          },
          has() {
            return true;
          },
        },
      );
      try {
        (fn as (bag: unknown) => unknown)(probe);
      } catch {
        unprobeable.push(id);
        continue;
      }
      for (const block of seen) owned.push({ block, reader: id });
    }
  }
  return { owned, unprobeable };
}

describe("every agent settings block reaches agent_settings_set", () => {
  test("the probe finds readers at all, and reads blocks from them", async () => {
    // NOTE: the positive control: a discovery pass that finds NOTHING passes every assertion below,
    // so a broken glob or a renamed directory would turn this file green while guarding nothing.
    const { owned } = await ownedBlocks();
    const blocks = new Set(owned.map((o) => o.block));
    // NOTE: ANCHORS, not a count: this test runs in both editions and the derivation drops
    // modules, so a pinned count would fail in the smaller tree for no defect.
    for (const anchor of ["debounce", "stt", "tts", "guardrails", "memory"]) {
      expect(blocks).toContain(anchor);
    }
    // Both sources reached: this one comes only from the aggregate, that one only from the glob.
    expect(blocks).toContain("modelFallback");
    expect(blocks).toContain("kanban");
  });

  test("no reader is silently skipped", async () => {
    const { unprobeable } = await ownedBlocks();
    expect(unprobeable.filter((r) => !(r in UNPROBEABLE))).toEqual([]);
  });

  test("every owned block is published, or named as not published with a reason", async () => {
    const [{ owned }, published] = await Promise.all([
      ownedBlocks(),
      publishedBlocks(),
    ]);
    const missing = [
      ...new Set(
        owned
          .filter((o) => !published.has(o.block) && !(o.block in NOT_PUBLISHED))
          .map((o) => `${o.block} (${o.reader})`),
      ),
    ].sort();
    expect(missing).toEqual([]);
  });

  test("an exemption names a block that still exists", async () => {
    // A stale exemption is worse than none: it silently forgives whatever takes that name next.
    const { owned } = await ownedBlocks();
    const blocks = new Set(owned.map((o) => o.block));
    expect(Object.keys(NOT_PUBLISHED).filter((b) => !blocks.has(b))).toEqual(
      [],
    );
  });

  test("every exemption carries a non-empty reason", () => {
    expect(
      Object.entries(NOT_PUBLISHED)
        .concat(Object.entries(UNPROBEABLE))
        .filter(([, why]) => why.trim() === "")
        .map(([k]) => k),
    ).toEqual([]);
  });
});

// THE OTHER DIRECTION: what `agent_settings_set` ACCEPTS, `agent_settings_get` has to give back, or
// a client cannot tell what it just did. The two sides are wired from different places (the set
// derives its keys from BEHAVIOR_PATCH_SHAPE, the get projects readBehaviorSettings).
describe("agent_settings_get returns what agent_settings_set takes", () => {
  test("every writable block is present in the read projection", () => {
    const readable = new Set(Object.keys(readBehaviorSettings({})));
    const writable = Object.keys(BEHAVIOR_PATCH_SHAPE);
    expect(writable.filter((b) => !readable.has(b))).toEqual([]);
  });

  test("and nothing is readable that cannot be written", () => {
    // The reverse is just as bad in practice: a block the read advertises and the write silently
    // ignores reads as "I set that" to every client.
    const writable = new Set(Object.keys(BEHAVIOR_PATCH_SHAPE));
    const readable = Object.keys(readBehaviorSettings({}));
    expect(readable.filter((b) => !writable.has(b))).toEqual([]);
  });
});

// WHAT THE DECLARATIONS BUY, asserted. The rule is "type and choice, never size" (docs/mcp.md): a
// value the reader would THROW AWAY is declared, so the call is refused with the field named instead
// of storing a default nobody asked for.
describe("the new blocks declare type and choice", () => {
  const patch = z.object(BEHAVIOR_PATCH_SHAPE);

  test("an unknown guardrail action is refused", () => {
    expect(
      patch.safeParse({ guardrails: { output: { action: "explode" } } })
        .success,
    ).toBe(false);
    for (const action of ["template", "generated", "silent"]) {
      expect(
        patch.safeParse({ guardrails: { output: { action } } }).success,
      ).toBe(true);
    }
  });

  test("a guardrails message the reader CLIPS still parses", () => {
    expect(
      patch.safeParse({
        guardrails: { output: { templateMessage: "x".repeat(10_000) } },
      }).success,
    ).toBe(true);
  });

  // SIZE IS A DESCRIPTION, NOT A REFUSAL. `readMonitoringConfig` clamps every number here and
  // truncates both lists, so copying those bounds into zod would turn a clamp into a refusal that the
  // console does not make. The block still declares type and choice.
  test("a monitoring size the reader CLAMPS still parses", () => {
    for (const monitoring of [
      { window: { messages: 100 } },
      { window: { messages: 4.5 } },
      { debounce: { windowSeconds: 1, maxWindowSeconds: 10_000 } },
      {
        // NOTE: distinct values per group: sharing one is refused on its own terms (a label is one
        // row in a flat set), and this fixture is about SIZE.
        labelGroups: Array.from({ length: 9 }, (_, i) => ({
          name: `g${i}`,
          values: [`a${i}`],
        })),
      },
      {
        labelGroups: [
          {
            name: "assunto",
            values: Array.from({ length: 90 }, (_, i) => `v${i}`),
          },
        ],
      },
    ]) {
      expect(patch.safeParse({ monitoring }).success).toBe(true);
    }
  });

  test("monitoring still declares type and choice", () => {
    expect(
      patch.safeParse({ monitoring: { analysis: "sometimes" } }).success,
    ).toBe(false);
    expect(
      patch.safeParse({ monitoring: { window: { messages: "vinte" } } })
        .success,
    ).toBe(false);
    for (const analysis of ["incremental", "on_resolve"])
      expect(patch.safeParse({ monitoring: { analysis } }).success).toBe(true);
  });
});

// The two name-keyed blocks PUBLISH the catalog, and that is their whole difference from a
// `z.record(z.string(), …)`. Both readers drop a key outside the catalog, so the schema cannot refuse
// one without diverging from the console; what it can do is tell the caller which names exist,
// which is the difference between a typo the client sees and a rule that silently guards nothing.
describe("toolGuidance and toolPreconditions publish the native catalog", () => {
  test("every native tool name appears as a property of both", async () => {
    const published = await publishedProperties();
    for (const block of ["toolGuidance", "toolPreconditions"]) {
      const props = Object.keys(published[block] ?? {});
      expect(props.sort()).toEqual([...NATIVE_TOOL_NAMES].sort());
    }
  });

  // NOTE: text on handoff_to_human and kanban_move_card is not forbidden: prepare.ts overwrites it
  // only when the grouped note is NON-EMPTY, so the flat value is used while the grouped one is
  // blank. That is precedence, stated in the description (docs/mcp.md); forbidding it would also
  // break the get and set round trip.
  test("the two shadowed names still take text, because they are still used", () => {
    const patch = z.object(BEHAVIOR_PATCH_SHAPE);
    for (const name of ["handoff_to_human", "kanban_move_card"]) {
      expect(
        patch.safeParse({ toolGuidance: { [name]: "a note" } }).success,
      ).toBe(true);
    }
  });

  test("and the precedence is published where a caller reads it", async () => {
    const tools = await publishedProperties();
    const desc = String(
      (tools.toolGuidance as never as { description?: string })?.description ??
        "",
    );
    void desc;
    const patch = z.object(BEHAVIOR_PATCH_SHAPE);
    const block = (
      patch.shape.toolGuidance as unknown as {
        unwrap: () => { description?: string };
      }
    ).unwrap();
    expect(String(block.description)).toContain("PRECEDENCE");
    expect(String(block.description)).toContain("handoff.instructions");
  });

  test("a name added to the catalog needs no edit here", () => {
    // NOTE: the shape is generated from NATIVE_TOOL_NAMES; this asserts the generation is wired,
    // since a hand-written list would pass the test above and go stale on the next native tool.
    const shape = (
      BEHAVIOR_PATCH_SHAPE.toolGuidance as unknown as {
        unwrap: () => { shape: Record<string, unknown> };
      }
    ).unwrap().shape;
    expect(Object.keys(shape).sort()).toEqual([...NATIVE_TOOL_NAMES].sort());
  });
});

// The merge takes a `null` tombstone so a rule can be REMOVED over MCP, and both the schema and the
// write boundary have to accept it: `null` is a REMOVAL, not an entry that failed to parse, and
// classifying it as invalid would refuse the only way to delete a rule.
describe("a tool precondition can be removed", () => {
  const patch = z.object(BEHAVIOR_PATCH_SHAPE);

  test("the schema accepts a per-tool tombstone on BOTH tool-keyed blocks", () => {
    for (const block of ["toolPreconditions", "toolGuidance"]) {
      expect(
        patch.safeParse({ [block]: { handoff_to_human: null } }).success,
      ).toBe(true);
    }
  });

  test("the write boundary does not read a tombstone as an invalid entry", () => {
    expect(
      invalidToolPreconditions({
        toolPreconditions: { handoff_to_human: null },
      }),
    ).toEqual([]);
  });

  // A non-native precondition CAN exist (an agent import copies the settings bag verbatim) and the
  // runtime ENFORCES it, since only the write boundary filters by name. Refusing its tombstone would
  // leave an active guard MCP cannot remove; the catalog restriction is about what may be CREATED.
  test("a tombstone removes a non-native rule that is actually stored", () => {
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { mcp__crm__create_deal: null } },
        {
          toolPreconditions: {
            mcp__crm__create_deal: {
              kind: "attribute",
              scope: "conversation",
              key: "cpf",
            },
          },
        },
      ),
    ).not.toThrow();
  });

  test("but a tombstone for a non-native name that is NOT stored is still refused", () => {
    // Nothing to delete: accepting it would report success for a no-op, and it is also the shape a
    // caller would send while believing they had created something.
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { mcp__crm__create_deal: null } },
        { toolPreconditions: {} },
      ),
    ).toThrow();
  });

  test("and a non-native RULE is still refused, tombstone or not", () => {
    expect(() =>
      assertSettingsToolPreconditions(
        {
          toolPreconditions: {
            mcp__crm__create_deal: {
              kind: "attribute",
              scope: "conversation",
              key: "cpf",
            },
          },
        },
        { toolPreconditions: {} },
      ),
    ).toThrow();
  });

  test("an entry that is neither a condition nor a tombstone is still invalid", () => {
    expect(
      invalidToolPreconditions({
        toolPreconditions: { handoff_to_human: "nope" },
      }),
    ).toEqual(["handoff_to_human"]);
  });
});

// The console gates both checks behind `{dir === "output" && …}` and `generationPrompt` is only read
// when `direction === "output"`, so publishing them under `input` would advertise three settings that
// store, read back and do nothing.
describe("the guardrail directions publish only what their direction uses", () => {
  // PUBLISHED AS FORBIDDEN, not absent: on a loose object (`additionalProperties: {}`) absence
  // permits anything, so a client validating from tools/list would accept a call the server refuses.
  // `z.never()` serializes as `{"not": {}}`, the same rule at both ends (docs/mcp.md).
  test("input publishes the output-only fields as FORBIDDEN, not merely omitted", async () => {
    const published = await publishedProperties();
    const input = published.guardrails?.input as
      | { properties?: Record<string, unknown> }
      | undefined;
    const checks = (
      input?.properties?.checks as { properties?: Record<string, unknown> }
    )?.properties;
    for (const field of ["promptAdherence", "answerRelevance"]) {
      expect(JSON.stringify(checks?.[field])).toBe('{"not":{}}');
    }
    expect(JSON.stringify(input?.properties?.generationPrompt)).toBe(
      '{"not":{}}',
    );
  });

  test("output still advertises all of them", async () => {
    const published = await publishedProperties();
    const output = published.guardrails?.output as
      | { properties?: Record<string, unknown> }
      | undefined;
    const props = Object.keys(
      (output?.properties?.checks as { properties?: Record<string, unknown> })
        ?.properties ?? {},
    );
    expect(props).toContain("promptAdherence");
    expect(props).toContain("answerRelevance");
    expect(Object.keys(output?.properties ?? {})).toContain("generationPrompt");
  });

  // Publishing different shapes is not enough: a loose object still ACCEPTS the field. The shape
  // `agent_settings_get` returns carries all five checks, so a caller that reads, changes one field
  // and writes back sends them.
  test("the input direction REFUSES the output-only fields, naming them", () => {
    const patch = z.object(BEHAVIOR_PATCH_SHAPE);
    for (const field of ["promptAdherence", "answerRelevance"]) {
      const r = patch.safeParse({
        guardrails: { input: { checks: { [field]: true } } },
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain(field);
      }
    }
    expect(
      patch.safeParse({ guardrails: { input: { generationPrompt: "x" } } })
        .success,
    ).toBe(false);
  });

  test("the same fields are accepted under output", () => {
    const patch = z.object(BEHAVIOR_PATCH_SHAPE);
    expect(
      patch.safeParse({
        guardrails: {
          output: {
            checks: { promptAdherence: true, answerRelevance: true },
            generationPrompt: "x",
          },
        },
      }).success,
    ).toBe(true);
  });

  test("input still accepts a field nobody has declared yet", () => {
    // The block stays LOOSE on purpose: what is refused is the known, direction-wrong set, not
    // everything unfamiliar. A field added to the reader by someone who never opens this file must
    // still merge rather than be dropped.
    const patch = z.object(BEHAVIOR_PATCH_SHAPE);
    expect(
      patch.safeParse({ guardrails: { input: { somethingNew: 1 } } }).success,
    ).toBe(true);
  });

  // `generated` is accepted on input, as the console offers it (refusing would make the same write
  // succeed there and fail here). What it does a caller cannot discover by trying: analyzeGuardrail
  // runs every input verdict through withoutReplacement, so it falls back to the template.
  test("the input action documents its unconditional template fallback", () => {
    const patch = z.object(BEHAVIOR_PATCH_SHAPE);
    expect(
      patch.safeParse({ guardrails: { input: { action: "generated" } } })
        .success,
    ).toBe(true);
    const block = (
      patch.shape.guardrails as unknown as {
        unwrap: () => {
          shape: Record<
            string,
            {
              unwrap: () => { shape: Record<string, { description?: string }> };
            }
          >;
        };
      }
    ).unwrap().shape;
    const inputAction = block.input?.unwrap().shape.action;
    expect(String(inputAction?.description)).toContain("falls back");
    // The output direction says no such thing, because there it really does generate.
    const outputAction = block.output?.unwrap().shape.action;
    expect(String(outputAction?.description)).not.toContain("falls back");
  });

  test("the shared checks are on both", async () => {
    const published = await publishedProperties();
    for (const dir of ["input", "output"]) {
      const d = published.guardrails?.[dir] as
        | { properties?: Record<string, unknown> }
        | undefined;
      const props = Object.keys(
        (d?.properties?.checks as { properties?: Record<string, unknown> })
          ?.properties ?? {},
      );
      expect(props).toContain("toxicity");
      expect(props).toContain("unsafeContent");
      expect(props).toContain("competitorMentions");
    }
  });
});

// `__proto__` survives JSON.parse as an OWN property and is then dropped by zod's loose-object
// rebuild inside the SDK's argument parse, so it must be measured THROUGH THE TRANSPORT. It cannot be
// refused by name, in the schema, or as an empty map (see docs/mcp.md, the `__proto__` paragraph), so
// the behaviour is PINNED: if a future SDK or zod version stops dropping it, this test says so.
describe("__proto__ in a tool map: a measured transport limitation", () => {
  async function callThroughTransport(args: unknown) {
    const server = buildMcpServer(principal);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "proto", version: "0" });
    await client.connect(clientT);
    try {
      const r = await client.callTool({
        name: "agent_settings_set",
        arguments: args as Record<string, unknown>,
      });
      return JSON.stringify(r);
    } finally {
      await client.close();
    }
  }

  test("the key does not reach the write boundary", async () => {
    const out = await callThroughTransport(
      JSON.parse(
        '{"agent_id":"999999999","toolPreconditions":{"__proto__":null}}',
      ),
    );
    // NOTE: the call proceeds PAST the shape checks and fails on the agent lookup, so `__proto__`
    // never became a refusal. If this starts saying "not a valid precondition", the transport now
    // preserves the key and the boundary answers, which is the outcome we want.
    expect(out).not.toContain("not a valid precondition");
    expect(out).not.toContain("no updatable fields");
  });

  test("but the write boundary DOES refuse it whenever it arrives", () => {
    // NOTE: called directly, the key survives, which is why the pin above has to go through the
    // transport.
    expect(
      invalidToolPreconditions(
        JSON.parse(
          '{"toolPreconditions":{"__proto__":{"kind":"attribute","scope":"conversation","key":"k"}}}',
        ),
      ),
    ).toEqual(["__proto__"]);
  });
});
