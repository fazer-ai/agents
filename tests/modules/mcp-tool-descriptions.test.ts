import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

async function descriptions(): Promise<Map<string, string>> {
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
  return new Map(tools.map((t) => [t.name, t.description ?? ""]));
}

// NOTE: headroom over the current 3,534 for an ordinary edit, well under the 6,107 this replaced.
// Round 1's correction spent 118 of that headroom, which is the kind of edit it is there for.
const SETTINGS_DESC_CEILING = 3800;

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
