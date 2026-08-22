import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";

// Issue #161. A tool description is paid for by every client on every session, before it knows
// whether the tool will be used at all, and `agent_settings_set` had become the place every settings
// block appended a paragraph to: 6,107 characters, 23% of all description text across 95 tools, 4.9x
// the runner-up and 36x the median. The norm it is now held to is written down in docs/mcp.md.
//
// The two assertions below are deliberately different in kind. The ceiling is a RATCHET, not a style
// rule: it exists because the growth was monotonic and invisible, and its job is to make the next
// append a decision rather than a reflex. Raising it is a legitimate outcome of that decision — what
// is not legitimate is not noticing. The second asserts what must SURVIVE a trim, because a ceiling
// on its own invites cutting whatever is easiest rather than whatever is cheapest.

async function listed(): Promise<
  Map<string, { description: string; schema: string }>
> {
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
  const client = new Client({ name: "desc-check", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(
    tools.map((t) => [
      t.name,
      {
        description: t.description ?? "",
        schema: JSON.stringify(t.inputSchema),
      },
    ]),
  );
}

async function descriptions(): Promise<Map<string, string>> {
  return new Map([...(await listed())].map(([n, t]) => [n, t.description]));
}

// NOTE: headroom over the current 1,931 for an ordinary edit, the same slack the 3,800 carried over
// 3,534. Issue #142 spent 166 of that slack and the ceiling is deliberately NOT moving for it: what
// went into the prose is only the half a caller cannot read off the schema (a summariser override
// that is stored without complaint and then never runs), and 69 characters of remaining headroom is
// the ratchet doing its job, not a number to relieve. The next append here is a decision. What was 6,107 before #161 and 3,534 after it came down again when #174 moved every field
// name, choice and range into the schema; what is left is the rules a caller cannot read off either
// the schema or docs/ — the ones that REFUSE a call, and the ones the write accepts and the runtime
// then never acts on.
const SETTINGS_DESC_CEILING = 2_000;

// NOTE: the ratchet has to follow the content. A ceiling on the description alone would have watched
// the half that shrank while the shape it moved into grew unwatched — `tools/list` ships both, and a
// client pays for both before it knows whether the tool will be used. Headroom over the current
// 9,711 is deliberately tighter than a whole block (~600 characters), so the next block declaring
// its fields here is a decision rather than a reflex.
//
// RAISED from 10,200 for issue #142, and the raise is the decision the ceiling exists to force. The
// `memory.compaction` block gained the summariser's own model override — the same quartet tts
// carries for its rewrite — and it costs 524 characters, near enough a whole block. Most of that is
// the provider ENUM, which is the one part worth publishing: it is the list a client renders. The
// only discretionary 72 in it is the `null inherits the agent's` note on that enum, and trimming it
// to fit under 10,200 was the available move and the wrong one — null is the whole semantics of the
// override, and cutting the sentence that explains it is cutting what is easiest rather than what is
// cheapest. Headroom over 10,235 stays tighter than a block, as before.
//
// RAISED from 10,600 for issue #182, and again the raise is the decision the ceiling forces. The
// `contactAuth` block declares nine fields and costs 1,068 characters, above a whole block, and
// trimming it to fit was tried first: it bought 92. What is left is not padding. Three of the nine
// carry a note a caller cannot get by trying, and each names a way the block fails SILENTLY.
// `noticeCooldownSeconds` reads as a verdict cache to anyone who has met one, and a caller who
// believes it is caching sets it high and thinks revocation is instant when it is not.
// `includeMessageText` is read as false under GET, so the unlock flow is configured, stored,
// and never runs. `denyMessage: null` means say nothing, which is a refusal the customer sees no
// sign of. The rest is the shape: nine fields, an enum and the nullable wrappers, and that part
// does not compress. Headroom over 11,303 stays tighter than a block, as before.
const SETTINGS_SCHEMA_CEILING = 11_650;

describe("MCP tool descriptions", () => {
  test("agent_settings_set stays under its ceiling", async () => {
    const d = (await descriptions()).get("agent_settings_set");
    expect(d).toBeDefined();
    expect((d as string).length).toBeLessThanOrEqual(SETTINGS_DESC_CEILING);
  });

  // NOTE: the half a model cannot recover from the schema, because the schema declares every block
  // as an untyped record. A call that gets one of these wrong is REFUSED, not clamped, so the cost
  // of trimming them is a failed write the caller cannot diagnose.
  test("the rules that refuse a call survive the trim", async () => {
    const d = (await descriptions()).get("agent_settings_set") as string;
    // NOTE: the patch is merged, not a replacement, and the difference is the caller's whole mental model.
    expect(d).toContain("PARTIAL patch MERGED");
    // NOTE: nothing is written unless dry_run is turned off.
    expect(d).toContain("dry_run");
    // NOTE: a model id and a key belong to the vendor they were picked from, and this one is NOT a
    // refusal. resolveNormalizeModel decides it at READ time (`override_without_provider`), so the
    // write succeeds and the rewrite silently never runs; the description that called it a refusal
    // was the one thing a caller could not have found out by trying. Trimming the "never runs" half
    // is how it got there: the text this replaced said "refused AND the rewrite is skipped".
    expect(d).toContain("stored without complaint and the rewrite NEVER RUNS");
    // NOTE: over-long operator text is refused rather than silently shortened.
    expect(d).toContain("refused, not trimmed");
    // NOTE: a credential travels as a name or a stable ref, never as a secret.
    expect(d).toContain("NAME or a stable vault:<id>");
    // NOTE: the same read-time outcome on the summariser, and the one place it differs: an
    // attendance ends and nothing is written, so the thread stays raw and the memory the whole
    // feature exists to keep is the thing that goes missing. Asserted separately from the tts
    // clause it shares a sentence with, because a trim that keeps one and drops the other reads
    // as a smaller edit than it is.
    expect(d).toContain(
      "stops the SUMMARISER instead and the thread stays raw",
    );
  });

  test("agent_settings_set stays under its schema ceiling", async () => {
    const t = (await listed()).get("agent_settings_set");
    expect(t).toBeDefined();
    expect((t as { schema: string }).schema.length).toBeLessThanOrEqual(
      SETTINGS_SCHEMA_CEILING,
    );
  });

  // NOTE: the two move together, or the maintenance doubles instead of halving. A field the schema
  // declares and the paragraph repeats is a second copy that drifts silently — which is exactly how
  // `vision.provider` came to be published as three providers while the registry had five. Only
  // camelCase names are checked: they cannot appear in prose by accident, unlike "mode" or "model".
  test("the description does not restate what the schema declares", async () => {
    const declared = new Set<string>();
    for (const key of Object.keys(BEHAVIOR_PATCH_SHAPE)) {
      const block =
        BEHAVIOR_PATCH_SHAPE[key as keyof typeof BEHAVIOR_PATCH_SHAPE].unwrap();
      for (const field of Object.keys(block.shape)) declared.add(field);
    }
    // NOTE: the names a REFUSAL rule has to spell out. They are in the description because of what
    // happens to the call, not because of what shape the field has.
    const namedByARule = new Set([
      "credentialRef",
      "normalizeProvider",
      "normalizeModel",
      "normalizeCredentialRef",
      "awayMessage",
      "extractionPrompt",
    ]);
    const d = (await descriptions()).get("agent_settings_set") as string;
    const restated = [...declared]
      .filter((f) => /[a-z][A-Z]/.test(f) && !namedByARule.has(f))
      .filter((f) => d.includes(f));
    expect(restated).toEqual([]);
  });

  // NOTE: the norm is about WHERE content lives, not about length, so the check that matters for the
  // other tools is that none of them grew a second offender while nobody was counting.
  test("no other description is anywhere near that size", async () => {
    const all = await descriptions();
    const others = [...all]
      .filter(([name]) => name !== "agent_settings_set")
      .map(([name, d]) => ({ name, len: d.length }))
      .sort((a, b) => b.len - a.len);
    expect(others[0]?.len).toBeLessThanOrEqual(1500);
  });
});
