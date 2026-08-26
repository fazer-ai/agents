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

async function listedFor(scopes: string[]): Promise<Set<string>> {
  const principal: VerifiedToken = {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes,
    clientId: "c",
    jti: "j",
  };
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "scope-check", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

// The scope contract from docs/mcp.md, as a sweep rather than a list of names: everything that only
// READS is visible to a read-only token. Stated this way it also catches the next read tool that
// gets registered in the write block by being pasted next to its siblings — which is exactly how
// the four document reads ended up invisible to an AGENT-role token.
describe("scope contract", () => {
  test("every *_list / *_get / *_schema tool is visible to mcp:read alone", async () => {
    const all = await listedFor(["mcp:read", "mcp:write"]);
    const readOnly = await listedFor(["mcp:read"]);
    const reads = [...all].filter((n) => /(_list|_get|_schema)$/.test(n));
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.filter((n) => !readOnly.has(n))).toEqual([]);
  });

  test("a read-only token sees no write tool", async () => {
    const readOnly = await listedFor(["mcp:read"]);
    expect(
      [...readOnly].filter((n) => /(_set|_create|_update|_delete)$/.test(n)),
    ).toEqual([]);
  });
});

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
//
// RAISED from 11,650 for issue #58, and this time the trim came first and bought most of it. The
// `observability` block gained one field, `fullDetailUntil`, and typing it as `z.iso.datetime()`
// published a 430-character regex — a third of a whole block's budget spent restating a format the
// description states in four words. Declaring it a plain string moved the check into a `refine`,
// which publishes nothing, and gave back 351 of the 738 the field had cost. What is left is the
// field name, the nullable wrapper, and one sentence a caller cannot get by trying: that the value
// is the instant the mode ENDS rather than a duration or a switch, and that the mode stores log
// detail whole instead of cutting it at 2,000. Headroom over 11,690 stays tighter than a block, as
// before.
//
// RAISED from 12,050 for issue #143, and the trim was measured BEFORE the raise rather than after.
// The `modelFallback` block declares the same quartet the two other model overrides carry and costs
// 657 characters; dropping BOTH its `describe` notes buys 130 and still does not fit. So the raise
// is not avoidable by trimming, and trimming would only delete the half a caller cannot get by
// trying: a fallback needs a provider AND a model, and naming one of the two stores a block that
// reads as configured and can never run — the same silent-failure shape every raise above paid for.
// The remaining 527 is the shape (four fields, the provider enum, the nullable wrappers) and does
// not compress. Headroom over 12,347 stays tighter than a block, as before.
//
// RAISED from 12,400 for issue #103, and the trim was measured first, against the 53 characters
// #143 left. `ignoreAppointmentPause` on a follow-up step costs 201 with the note it was written
// with; rewriting the note to its shortest honest form buys 48 and lands at 153, which still does
// not fit. Dropping the note entirely WOULD fit, and that is precisely the trade every raise above
// refuses: what it says is the one thing a caller cannot get by trying, because the flag is INERT
// unless `followUp.pauseWhileAppointment` is on. Without it a caller exempts a step, stores a block
// that reads as configured, and nothing about that step ever fires differently — the same
// silent-failure shape as `includeMessageText` and the half-named `modelFallback` above. The
// remaining 153 is the field name, the boolean, and that sentence. Headroom over 12,500 stays
// tighter than a block, as before.
const SETTINGS_SCHEMA_CEILING = 12_550;

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

  // The instrument the ceiling above did NOT have. It guards the schema of exactly one tool, so a
  // second heavy schema could land anywhere else and pass green — and the schema half is the larger
  // one: 38k characters against 25k of prose, published in full on every tools/list of every
  // session, before a client knows whether any of it will be used.
  //
  // Measured with the document tools in: 103 tools, 25,738 characters of description and 39,726 of
  // schema. The headroom below is deliberately smaller than one substantial tool, so the next
  // addition is a decision — raising these is a legitimate outcome of that decision, and not
  // noticing is not.
  //
  // The schema figure was 38,379 when this test was written and the cap 39,500. It moved because the
  // `contactAuth` block landed on the base while this branch was open, costing 1,347 characters of
  // agent_settings_set — the same addition that raised SETTINGS_SCHEMA_CEILING above. Re-measured
  // rather than trimmed: nothing here grew, the total simply now includes a block that was not in it
  // when the number was taken, and cutting a document description to fit an unrelated arrival is
  // cutting what is easiest rather than what is cheapest.
  //
  // The description figure moved again for issue #305, which added three tools (delivery list, get
  // and requeue) at 748 characters against 467 of headroom. Raised deliberately, and only after the
  // two that could be trimmed without costing the model anything were: `_get` stopped restating the
  // field list that `_list` publishes one line above it. The delivery ledger is a surface an
  // operator agent needs to be able to find, so the alternative here was not a smaller number, it
  // was a tool nobody can call. The schema figure moved with it, by 345: most of that is
  // `webhook_delivery_list`, whose seven filters and four-value status enum are the whole point of
  // a dead-letter view, and the enum is derived from the module's vocabulary rather than hand-typed
  // (see the note at its registration) so shrinking it here would mean advertising fewer statuses
  // than the surface accepts.
  // Issue #143 moves the SCHEMA figure and not the description one: `agent_settings_set` is the only
  // tool the `modelFallback` block reaches, and a block publishes fields, not prose. Re-measured
  // rather than trimmed, for the reason the paragraph above gives — the alternative is cutting an
  // unrelated document description to pay for it.
  //
  // The two arrived together on the way to the merge, so these figures are a FRESH measurement of
  // the combined tree rather than either branch's number: adding the two deltas would assume nothing
  // else moved between them, and it does not survive the measurement. Measured here: 26,764 of
  // description and 41,852 of schema. The DESCRIPTION ceiling therefore does NOT move for #143 —
  // this block publishes a schema and no new tool, so #305's number still has room and raising it
  // would have been a number nobody had measured. The schema ceiling does, to 41,950.
  //
  // #103 moves the schema figure again and not the description one, for the same reason: the
  // follow-up step gains one boolean and its note, and no tool is added. Measured at 42,027 of
  // schema after the trim documented at SETTINGS_SCHEMA_CEILING, so the ceiling goes to 42,100.
  test("the whole tools/list payload stays under its ceiling", async () => {
    const all = await listed();
    let desc = 0;
    let schema = 0;
    for (const t of all.values()) {
      desc += t.description.length;
      schema += t.schema.length;
    }
    expect(desc).toBeLessThanOrEqual(27_250);
    expect(schema).toBeLessThanOrEqual(42_100);
  });

  // Why the document write tools declare `blocks`/`fields` as loose arrays and put the vocabulary in
  // document_template_schema instead: a six-variant discriminated union publishes as JSON Schema by
  // inlining every variant, measured at ~3.2k characters PER TOOL against the ~700 below, on both
  // the create and the update. That trade is the reason the totals above are where they are, so it
  // is asserted rather than left as a claim in a comment.
  test("the document write tools keep their schemas compact", async () => {
    const all = await listed();
    for (const name of [
      "document_template_create",
      "document_template_update",
    ]) {
      const t = all.get(name);
      expect(t).toBeDefined();
      expect((t as { schema: string }).schema.length).toBeLessThanOrEqual(
        1_000,
      );
    }
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
