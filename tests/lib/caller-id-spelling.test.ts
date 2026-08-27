import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// The spelling this app is not allowed to write again, wherever a caller's id enters it.
//
// `src/lib/db-id.ts` has named `BigInt(params.id)` as the one to avoid since it was written, and the
// count when the path half of this fence was added was ONE HUNDRED sites across eighteen
// controllers (#371). The body half came to a further eleven (#407), and it is the reason this
// sweep reads the whole of `src` rather than `src/api`: the parse a body id needs happens in a
// service as often as in a handler, and the transports that are not HTTP at all — an MCP tool's
// arguments, an agent-export bundle, a `vault:<id>` reference — reach the same columns.
//
// A rule stated in a header is a rule the next author inherits only if they read the header; this
// file is the half that does not depend on their reading it. It is a SOURCE sweep and not a request
// sweep on purpose: the behaviour is covered over the real route table in
// tests/api/v1/route-id-refusal.test.ts and tests/api/v1/body-id-refusal.test.ts, and those files
// can only reach routes they can call. What a site WROTE is visible here the moment it is written.

// `BigInt` applied to a field of something a caller sent. Named by the identifiers this codebase
// actually binds a request to; an alias it has never used would slip past, which is why the sweep
// below is a floor and the wire tests are the proof.
const MEMBER =
  /BigInt\(\s*(?:params|body|query|args|patch|input|data|b|g)\.[A-Za-z0-9_.]+/;

// `BigInt` applied to a bare local. This is the shape the member pattern cannot see — a `.map()`
// callback (`ids.map((s) => BigInt(s))`), a split segment, a helper's one argument — and it is
// where two of the eleven lived.
const BARE = /BigInt\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*[),]/;

// A bare `BigInt` whose argument is not a caller's id, with the reason. Listed rather than quietly
// skipped, and asserted in both directions: an entry that stops matching is describing code that no
// longer exists, and the size is pinned so that silencing a NEW site costs a second, visible edit.
const NOT_A_CALLERS_ID: Record<string, string> = {
  "src/lib/db-id.ts":
    "the bounded parse itself — this is the one `BigInt` the rule is written around.",
  "src/graph/checkpointer.ts":
    "a thread-id prefix COMPARED to the acting tenant's id and never bound to a query; a value that is not an id fails the comparison, which is the fence answering correctly.",
  "src/graph/ingest-job.ts":
    "a scheduler job payload this app enqueued from ids it had already parsed, not a field any caller writes.",
  "src/modules/memory/compact.ts":
    "a checkpoint this app wrote; the shape is guarded above the cast and the whole parse answers null.",
  "src/modules/rag/documents.ts":
    "a RAG_INGEST job payload this app enqueued after the document id was parsed at the route.",
};

// Only the CODE. Every one of these patterns appears in the prose that explains it — `db-id.ts`
// spells the forbidden call out twice in its own header — so a sweep that reads comments reports
// its own documentation as the offence.
export function codeLines(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  src.split("\n").forEach((raw, i) => {
    let text = raw;
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end === -1) return;
      text = text.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const open = text.indexOf("/*");
      if (open === -1) break;
      const close = text.indexOf("*/", open + 2);
      if (close === -1) {
        text = text.slice(0, open);
        inBlock = true;
        break;
      }
      text = text.slice(0, open) + text.slice(close + 2);
    }
    const lineComment = text.indexOf("//");
    if (lineComment !== -1) text = text.slice(0, lineComment);
    if (text.trim()) out.push({ line: i + 1, text });
  });
  return out;
}

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    files.set(file, await Bun.file(file).text());
  }
  return files;
}

function hits(src: string, pattern: RegExp): number[] {
  return codeLines(src)
    .filter(({ text }) => pattern.test(text))
    .map(({ line }) => line);
}

describe("a caller's id is parsed, never cast", () => {
  test("no site casts a field of a request with BigInt", async () => {
    const offenders: string[] = [];
    for (const [path, src] of await sources()) {
      for (const line of hits(src, MEMBER)) offenders.push(`${path}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no site casts a bare local with BigInt, outside the listed few", async () => {
    const offenders: string[] = [];
    const exemptWithNothingToExempt: string[] = [];
    for (const [path, src] of await sources()) {
      const found = hits(src, BARE);
      if (path in NOT_A_CALLERS_ID) {
        if (found.length === 0) exemptWithNothingToExempt.push(path);
        continue;
      }
      for (const line of found) offenders.push(`${path}:${line}`);
    }
    expect(offenders).toEqual([]);
    expect(exemptWithNothingToExempt).toEqual([]);
  });

  test("the not-a-callers-id ledger may only shrink", () => {
    expectWaiverLedger("NOT_A_CALLERS_ID", NOT_A_CALLERS_ID, 5);
  });

  // The sweep is worth nothing if it reads no files, and a wrong cwd or a renamed directory is
  // exactly how that happens silently.
  test("the sweep reads the tree", async () => {
    const files = await sources();
    expect(files.size).toBeGreaterThanOrEqual(300);
    expect(files.has("src/api/v1/agents.controller.ts")).toBe(true);
    expect(files.has("src/modules/agents/service.ts")).toBe(true);
  });

  // The controls: both patterns have to match the spellings they forbid and leave the parses alone,
  // or the tree above is green because nothing is being looked for.
  test("the patterns match what they forbid and nothing else", () => {
    for (const sample of [
      "        BigInt(params.id),",
      "BigInt( params.mediaId )",
      "agentId: b.agentId ? BigInt(b.agentId) : undefined,",
      "knowledgeBaseId: BigInt(body.knowledgeBaseId),",
      "id = BigInt(args.tenant_id);",
      "BigInt(data.businessHoursId)",
    ]) {
      expect(MEMBER.test(sample)).toBe(true);
    }
    for (const sample of [
      "body.knowledgeBaseIds?.map((s) => BigInt(s)),",
      "where: { id: BigInt(sel) },",
      "return BigInt(v);",
      "return [BigInt(raw)];",
    ]) {
      expect(BARE.test(sample)).toBe(true);
    }
    for (const sample of [
      "requireDbId(params.id)",
      'optionalDbId(b.agentId, "agentId")',
      "parseDbId(raw)",
      "BigInt(7)",
      'BigInt("7")',
    ]) {
      expect(MEMBER.test(sample)).toBe(false);
      expect(BARE.test(sample)).toBe(false);
    }
  });

  // …and the comment stripper has to strip, or every header that NAMES the forbidden call reports
  // itself. It also has to leave code alone, or the sweep goes blind in the other direction.
  test("the stripper drops prose and keeps code", () => {
    const src = [
      "// never write BigInt(params.id) again",
      "/* BigInt(body.x)",
      "   still a comment BigInt(args.y) */",
      "const a = BigInt(params.id); // BigInt(body.z)",
      "const b = 1;",
    ].join("\n");
    expect(codeLines(src).map((l) => l.line)).toEqual([4, 5]);
    expect(hits(src, MEMBER)).toEqual([4]);
  });
});
