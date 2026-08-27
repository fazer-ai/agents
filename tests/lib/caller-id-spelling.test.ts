import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// Every `BigInt` in the tree whose argument is not a literal, and the reason each one is allowed.
//
// `src/lib/db-id.ts` has named `BigInt(params.id)` as the spelling to avoid since it was written,
// and the count when the path half of this fence was added was ONE HUNDRED sites across eighteen
// controllers (#371). The body half came to nineteen more (#407), and two rounds of narrowing
// taught the shape this file ended up in.
//
// It reads ALL of `src`, not `src/api`, because the parse a body id needs happens in a service as
// often as in a handler, and because the transports that are not HTTP at all — an MCP tool's
// arguments, an agent-export bundle, a `vault:<id>` reference, a scheduler payload — reach the same
// columns. It matches on the ARGUMENT rather than on a list of variable names, because a pattern
// keyed on `params|body|query|args` cannot see `BigInt(r.slice(…))` or `BigInt(parts[2])`, and both
// of those were real sites: the review round that caught them found seven copies of the vault-ref
// slice, four of which spelled the prefix as a literal.
//
// And it is a SOURCE sweep, not a request sweep: the wire behaviour is covered in
// tests/api/v1/route-id-refusal.test.ts and tests/api/v1/body-id-refusal.test.ts, and those files
// can only reach routes they can call. What a site WROTE is visible here the moment it is written.

// A `BigInt` whose argument is not a caller's id, keyed by the argument text so that a NEW call in
// an already-listed file still fails. Asserted in both directions — an entry that stops matching is
// describing code that no longer exists — and size-pinned, so silencing a new site costs a second,
// visible edit rather than an append.
const NOT_A_CALLERS_ID: Record<string, string> = {
  "src/lib/db-id.ts | raw":
    "the bounded parse itself — the one `BigInt` every rule here is written around.",
  "src/modules/vault/service.ts | raw":
    "`readVaultRefId`, the reader's parse: lenient about spelling by contract (canonicalVaultRef) and bounded by range right below this call.",
  "src/client/lib/credentialRef.ts | ref.slice(VAULT_REF_PREFIX.length)":
    "the console's mirror of that same reader; it produces a string to COMPARE against the vault list and never reaches a query.",
  "src/api/lib/auth.ts | payload.userId":
    "the subject of a JWT this server signed; a token that fails to convert is answered as no session at all.",
  "src/api/v1/oauth-google.controller.ts | state.entryId":
    "an id out of OAuth state this server signed and has already verified, minted from a row's own id.",
  "src/api/v1/oauth-mcp.controller.ts | state.entryId":
    "same, on the MCP flow.",
  "src/modules/channel-redirect/followup.ts | payload.agentId":
    "a scheduler job payload this app enqueued from an id it had already parsed.",
  "src/graph/ingest-job.ts | instanceId":
    "a scheduler job payload this app enqueued; the shape is guarded above the cast.",
  "src/graph/ingest-job.ts | agentId": "same payload, same guard.",
  "src/modules/memory/compact.ts | instanceId":
    "a checkpoint this app wrote; the shape is guarded above the cast and the whole parse answers null.",
  "src/modules/memory/compact.ts | agentId": "same checkpoint, same guard.",
  "src/modules/rag/documents.ts | rawId":
    "a RAG_INGEST job payload this app enqueued after the document id was parsed at the route.",
  "src/modules/mcp/tenant-target.ts | tenant.id":
    "the id of a row already loaded, re-read off its DTO.",
  "src/api/v1/v1.controller.ts | tenant.id":
    "the id of the tenant row this handler just created.",
  "src/modules/chatwoot/management.ts | only.instanceId":
    "an instance id this function stringified from its own row a few lines above.",
  "src/modules/webhooks/outbound/deliveries.ts | dto.subscriptionId":
    "a subscription id off the DTO of the row this function just updated.",
  "src/graph/tools/documents.ts | issued.id":
    "the id of the document row this tool just issued.",
};

// Only the CODE. Every pattern here appears in the prose that explains it — `db-id.ts` spells the
// forbidden call out twice in its own header — so a sweep that reads comments reports its own
// documentation as the offence. String CONTENTS go too: a sentence can quote the call.
export function codeOf(src: string): string {
  let out = "";
  let quote: string | null = null;
  let block = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (block) {
      if (c === "*" && src[i + 1] === "/") {
        block = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      block = true;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c + c;
      continue;
    }
    out += c;
  }
  return out;
}

// The argument of every `BigInt(...)` call, whitespace collapsed so a reformat does not move a
// waiver. Balanced-paren, so a nested call comes back whole rather than truncated at its comma.
export function bigIntArgs(code: string): string[] {
  const found: string[] = [];
  let at = code.indexOf("BigInt(");
  while (at !== -1) {
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = at + 6; i < code.length; i++) {
      const c = code[i] as string;
      if (quote) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) {
      // The trailing comma a formatter adds when the call wraps is not part of the argument, and a
      // waiver keyed with one would stop matching the day the line fits on one line again.
      found.push(
        code
          .slice(at + 7, end)
          .replace(/\s+/g, " ")
          .trim()
          .replace(/,$/, "")
          .trim(),
      );
    }
    at = code.indexOf("BigInt(", at + 7);
  }
  // A literal argument is the author's own constant, not anyone's input.
  return found.filter((a) => a !== "" && !/^["'`\d]/.test(a));
}

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    files.set(file, await Bun.file(file).text());
  }
  return files;
}

describe("a caller's id is parsed, never cast", () => {
  test("every non-literal BigInt in the tree is one that was argued for", async () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const [path, src] of await sources()) {
      for (const arg of bigIntArgs(codeOf(src))) {
        const key = `${path} | ${arg}`;
        seen.add(key);
        if (!(key in NOT_A_CALLERS_ID)) offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
    // …and the other direction: a waiver describing code that no longer exists is a waiver that
    // would silently cover the next call written in its place.
    expect(Object.keys(NOT_A_CALLERS_ID).filter((k) => !seen.has(k))).toEqual(
      [],
    );
  });

  test("the not-a-callers-id ledger may only shrink", () => {
    expectWaiverLedger("NOT_A_CALLERS_ID", NOT_A_CALLERS_ID, 17);
  });

  // The sweep is worth nothing if it reads no files, and a wrong cwd or a renamed directory is
  // exactly how that happens silently.
  test("the sweep reads the tree", async () => {
    const files = await sources();
    expect(files.size).toBeGreaterThanOrEqual(300);
    expect(files.has("src/api/v1/agents.controller.ts")).toBe(true);
    expect(files.has("src/modules/agents/service.ts")).toBe(true);
  });

  // The control: the extractor has to find the shapes this fence exists for, INCLUDING the two the
  // earlier name-based patterns could not see, and leave the parses and the literals alone.
  test("the extractor finds every shape a cast can take", () => {
    expect(
      bigIntArgs(
        codeOf(
          [
            "BigInt(params.id)",
            "agentId: b.agentId ? BigInt(b.agentId) : undefined,",
            "ids.map((s) => BigInt(s))",
            "ids.push(BigInt(r.slice(VAULT_REF_PREFIX.length)));",
            "BigInt(parts[2] as string)",
            "BigInt(\n  data.businessHoursId,\n)",
          ].join("\n"),
        ),
      ),
    ).toEqual([
      "params.id",
      "b.agentId",
      "s",
      "r.slice(VAULT_REF_PREFIX.length)",
      "parts[2] as string",
      "data.businessHoursId",
    ]);
  });

  test("it leaves literals, prose and quoted code alone", () => {
    const src = [
      "// never write BigInt(params.id) again",
      "/* BigInt(body.x)",
      "   still a comment BigInt(args.y) */",
      'throw new Error("BigInt(query.z) is banned");',
      "const a = BigInt(7);",
      'const b = BigInt("7");',
      "const c = requireDbId(params.id);",
    ].join("\n");
    expect(bigIntArgs(codeOf(src))).toEqual([]);
  });
});
