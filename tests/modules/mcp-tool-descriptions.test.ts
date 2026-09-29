import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CODE_TOOL_CONTEXT_NAMES } from "@/lib/code-tool-vocabulary";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";

// A tool description is paid for by every client on every session, before it knows whether the
// tool will be used at all; the norm these tests hold is in docs/mcp.md ("What a tool description
// is for"). The ceilings are RATCHETS: raising one is a legitimate decision, not noticing is not.
// The assertions on content pin what must SURVIVE a trim, because a ceiling alone invites cutting
// whatever is easiest rather than whatever is cheapest.

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
// READS is visible to a read-only token. As a sweep it also catches a read tool registered in the
// write block by being pasted next to its siblings.
describe("scope contract", () => {
  test("every *_list / *_get / *_schema tool is visible to mcp:read alone", async () => {
    const all = await listedFor(["mcp:read", "mcp:write"]);
    const readOnly = await listedFor(["mcp:read"]);
    const reads = [...all].filter((n) => /(_list|_get|_schema)$/.test(n));
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.filter((n) => !readOnly.has(n))).toEqual([]);
  });

  // `filterScopes` grants exactly the scopes a client asked for, so `mcp:write` without `mcp:read`
  // is a real token. Its write tools point at the two authoring contracts instead of restating the
  // vocabulary and the limits, so those two have to be LISTED for it: a description naming a tool the
  // caller cannot see is worse than the duplication.
  test("a write-only token lists the tools its writes point at", async () => {
    const writeOnly = await listedFor(["mcp:write"]);
    for (const named of ["code_tool_schema", "document_template_schema"]) {
      expect([named, writeOnly.has(named)]).toEqual([named, true]);
    }
    // They stay visible to a reader too, which the sweep above assumes.
    const readOnly = await listedFor(["mcp:read"]);
    for (const named of ["code_tool_schema", "document_template_schema"]) {
      expect([named, readOnly.has(named)]).toEqual([named, true]);
    }
  });

  test("a read-only token sees no write tool", async () => {
    const readOnly = await listedFor(["mcp:read"]);
    expect(
      [...readOnly].filter((n) => /(_set|_create|_update|_delete)$/.test(n)),
    ).toEqual([]);
  });
});

// Headroom is small on purpose, so the next append is a decision. What stays in the prose is only
// what a caller cannot read off the schema or docs/: the rules that REFUSE a call, and the settings
// the write accepts and the runtime then never acts on.
const SETTINGS_DESC_CEILING = 2_000;

// The ratchet follows the content: `tools/list` ships the schema too, so a ceiling on the
// description alone would watch the half that shrank while the shape grew unwatched. Headroom stays
// tighter than one settings block; how a raise is decided (trim first, keep what a caller cannot
// learn by trying, re-measure instead of summing) is in docs/mcp.md, "Full admin surface".
const SETTINGS_SCHEMA_CEILING = 29_224;

describe("MCP tool descriptions", () => {
  test("agent_settings_set stays under its ceiling", async () => {
    const d = (await descriptions()).get("agent_settings_set");
    expect(d).toBeDefined();
    expect((d as string).length).toBeLessThanOrEqual(SETTINGS_DESC_CEILING);
  });

  // The half a caller cannot recover from the schema: the rules that REFUSE a call, and the settings
  // the write accepts and the runtime never acts on. Trimming them costs a failure the caller cannot
  // diagnose.
  test("the rules that refuse a call survive the trim", async () => {
    const d = (await descriptions()).get("agent_settings_set") as string;
    // NOTE: the patch is merged, not a replacement, and the difference is the caller's whole mental model.
    expect(d).toContain("PARTIAL patch MERGED");
    // NOTE: nothing is written unless dry_run is turned off.
    expect(d).toContain("dry_run");
    // NOTE: a model id and a key belong to the vendor they were picked from, and this one is NOT a
    // refusal: resolveNormalizeModel decides it at READ time (`override_without_provider`), so the
    // write succeeds and the rewrite silently never runs, which a caller cannot find out by trying.
    expect(d).toContain("stored without complaint and the rewrite NEVER RUNS");
    // NOTE: over-long operator text is refused rather than silently shortened.
    expect(d).toContain("refused, not trimmed");
    // NOTE: a credential travels as a name or a stable ref, never as a secret.
    expect(d).toContain("NAME or a stable vault:<id>");
    // NOTE: the same read-time outcome on the summariser: an attendance ends and nothing is written,
    // so the thread stays raw. Asserted apart from the tts clause it shares a sentence with, because a
    // trim that keeps one and drops the other reads as a smaller edit than it is.
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

  // The two move together, or the maintenance doubles instead of halving: a field the schema
  // declares and the paragraph repeats is a second copy that drifts silently. Only camelCase names
  // are checked: they cannot appear in prose by accident, unlike "mode" or "model".
  test("the description does not restate what the schema declares", async () => {
    const declared = new Set<string>();
    for (const key of Object.keys(BEHAVIOR_PATCH_SHAPE)) {
      const block =
        BEHAVIOR_PATCH_SHAPE[key as keyof typeof BEHAVIOR_PATCH_SHAPE].unwrap();
      for (const field of Object.keys(block.shape)) declared.add(field);
    }
    // The names a REFUSAL rule has to spell out. They are in the description because of what
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

  // The trade `code_tool_schema` exists to make: `code_tool_create` names the schema tool and
  // enumerates none of the vocabulary, so a session does not pay for two copies that can disagree. A
  // ceiling would not catch a regression (it is an upper bound and the payload has room), so the rule
  // is asserted by name.
  test("code_tool_create points at the schema instead of restating it", async () => {
    const d = (await descriptions()).get("code_tool_create");
    expect(d).toBeDefined();
    const desc = d as string;
    expect(desc).toContain("code_tool_schema");
    // NOTE: the context vocabulary, the limits and the failure semantics are the schema tool's to serve.
    for (const restated of CODE_TOOL_CONTEXT_NAMES) {
      expect([restated, desc.includes(restated)]).toEqual([restated, false]);
    }
    for (const restated of ["TIMEZONE", "NOW_LOCAL", "1000 ms", "32 MB"]) {
      expect([restated, desc.includes(restated)]).toEqual([restated, false]);
    }
  });

  // The whole tools/list payload, description and schema, is published on every session before a
  // client knows whether any of it is used. A ceiling on one tool's schema lets a second heavy schema
  // land anywhere else and pass, so the totals are ratcheted too, with headroom smaller than one
  // substantial tool. How a raise is decided: docs/mcp.md, "Full admin surface".
  test("the whole tools/list payload stays under its ceiling", async () => {
    const all = await listed();
    let desc = 0;
    let schema = 0;
    for (const t of all.values()) {
      desc += t.description.length;
      schema += t.schema.length;
    }
    expect(desc).toBeLessThanOrEqual(31_503);
    expect(schema).toBeLessThanOrEqual(64_799);
  });

  // Why the document write tools declare `blocks`/`fields` as loose arrays and put the vocabulary in
  // document_template_schema instead: a six-variant discriminated union publishes as JSON Schema by
  // inlining every variant, about 3.2k characters PER TOOL, on both the create and the update. That
  // trade is part of why the totals above are where they are, so it is asserted here.
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

  // The norm is about WHERE content lives, not about length, so the check that matters for the
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
