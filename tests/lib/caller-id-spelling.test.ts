/**
 * biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings below are SOURCE CODE fed
 * to the extractor under test, and a template hole is one of the shapes it has to classify.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// Every `BigInt` in the tree whose argument is not a literal, and the reason each one is allowed
// (`src/lib/db-id.ts` names `BigInt(params.id)` as the spelling to avoid). It reads ALL of `src`,
// because body ids are parsed in services too and MCP tools, export bundles, `vault:<id>` refs and
// scheduler payloads reach the same columns. It matches on the ARGUMENT, since a pattern keyed on
// `params|body|query|args` cannot see `BigInt(r.slice(…))` or `BigInt(parts[2])`. A SOURCE sweep,
// not a request sweep: tests/api/v1/route-id-refusal.test.ts and body-id-refusal.test.ts cover the
// wire, but only for routes they can call.

// A `BigInt` whose argument is not a caller's id, keyed by the argument text so that a NEW call in
// an already-listed file still fails. Asserted in both directions (an entry that stops matching
// describes code that no longer exists) and size-pinned, so silencing a new site costs a second,
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

// `blankNonCode` (below) blanks comments and string CONTENTS to spaces of the same length, so a
// `BigInt(` quoted in prose or an error message is not a call. Length-PRESERVING because the argument
// text is sliced from the original source at these offsets: collapsing strings would make
// `slice("vault:".length)` and `slice("other:".length)` one waiver key.
// `startsRegex`: whether the `/` at `at` opens a regex literal rather than dividing. After a value
// (identifier, literal, `)`, `]`) a slash divides; after an operator, punctuator or keyword it opens
// a pattern.
export function startsRegex(src: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(src[i] as string)) i--;
  if (i < 0) return true;
  const prev = src[i] as string;
  if (/[)\]}]/.test(prev)) return false;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j] as string)) j--;
    const word = src.slice(j + 1, i + 1);
    return KEYWORDS_BEFORE_REGEX.has(word);
  }
  return true;
}

// The keywords a regex literal can follow. `in` and `of` are here for `x in /re/.source`-shaped
// expressions; the set is small because everything else that can precede a pattern is punctuation.
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
]);

export function blankNonCode(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  // NOTE: one frame per template literal being walked. `depth < 0` means the walk is in the
  // template's TEXT (blank it); `depth >= 0` means it is inside a `${…}` hole, which is code and
  // stays. A stack because a hole can hold another template; blanking holes with the text would hide
  // `` `${BigInt(body.id)}` ``.
  const frames: { chunk: number; depth: number }[] = [];
  let i = 0;
  while (i < src.length) {
    const top = frames.at(-1);
    const c = src[i] as string;
    if (top && top.depth < 0) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        blank(top.chunk, i);
        top.depth = 0;
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(top.chunk, i);
        frames.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const to = close === -1 ? src.length : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let to = src.indexOf("\n", i);
      if (to === -1) to = src.length;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j++;
      }
      blank(i + 1, Math.min(j, src.length));
      i = Math.min(j + 1, src.length);
      continue;
    }
    // NOTE: a regex literal, whose body is not code and whose slashes are not comment openers. Read
    // as a line comment, `/https?:\/\//` would blank a cast written after it; read as code,
    // `/BigInt\(params\./` would be reported as a call that was never made.
    if (c === "/" && startsRegex(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j] as string;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      blank(i + 1, Math.min(j, src.length));
      i = Math.min(j + 1, src.length);
      continue;
    }
    if (c === "`") {
      frames.push({ chunk: i + 1, depth: -1 });
      i++;
      continue;
    }
    if (top) {
      if (c === "{") {
        top.depth++;
        i++;
        continue;
      }
      if (c === "}") {
        if (top.depth === 0) {
          top.depth = -1;
          top.chunk = i + 1;
        } else {
          top.depth--;
        }
        i++;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

// The argument of every `BigInt(...)` call, whitespace collapsed so a reformat does not move a
// waiver. Balanced-paren, so a nested call comes back whole rather than truncated at its comma.
// Detection runs over the blanked copy and the text comes out of the real source, so a waiver names
// exactly what was written.
export function bigIntArgs(src: string): string[] {
  const code = blankNonCode(src);
  const found: string[] = [];
  let at = code.indexOf("BigInt(");
  while (at !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = at + 6; i < code.length; i++) {
      const c = code[i] as string;
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
      // NOTE: the trailing comma a formatter adds when the call wraps is not part of the argument, and a
      // waiver keyed with one would stop matching the day the line fits on one line again.
      const tidy = (text: string) =>
        text.replace(/\s+/g, " ").trim().replace(/,$/, "").trim();
      const arg = tidy(src.slice(at + 7, end));
      // NOTE: WHOLLY a literal, judged on the blanked copy where a string's contents are spaces. An
      // argument that starts with a literal is not a literal (`BigInt("0" + params.id)`). A template
      // literal never counts as one: either it interpolates, or it hides interpolation from this check.
      const blanked = tidy(code.slice(at + 7, end));
      const isLiteral =
        /^(["'] *["']|[0-9][0-9_]*n?|0[xXoObB][0-9a-fA-F_]*n?)$/.test(blanked);
      if (arg !== "" && !isLiteral) found.push(arg);
    }
    at = code.indexOf("BigInt(", at + 7);
  }
  return found;
}

// The calls a ledger does not account for. A waiver covers ONE call, not a spelling: waiving by key
// alone would let a file gain a second `BigInt(raw)` beside the argued one while the sweep stays
// green. Separate from the sweep so the rule can be shown a case the tree does not contain.
export function unwaived(
  counts: Map<string, number>,
  ledger: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [key, n] of counts) {
    const allowed = key in ledger ? 1 : 0;
    if (n > allowed)
      out.push(n > 1 ? `${key} (${n} calls, ${allowed} waived)` : key);
  }
  return out;
}

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    // NOTE: RAW on purpose. `bigIntArgs` runs its own `blankNonCode` for detection and takes the
    // argument's TEXT as the ledger key, so pre-stripping rewrites the keys: `BigInt(ref.slice(
    // "vault:".length))` becomes an argument full of spaces and the waiver stops matching. The one
    // sweep in this family that must not be handed stripped source.
    files.set(file, await Bun.file(file).text());
  }
  return files;
}

describe("a caller's id is parsed, never cast", () => {
  test("every non-literal BigInt in the tree is one that was argued for", async () => {
    const counts = new Map<string, number>();
    for (const [path, src] of await sources()) {
      for (const arg of bigIntArgs(src)) {
        const key = `${path} | ${arg}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const offending = unwaived(counts, NOT_A_CALLERS_ID);
    expect(offending).toEqual([]);
    // NOTE: …and the other direction: a waiver describing code that no longer exists is a waiver that
    // would silently cover the next call written in its place.
    expect(Object.keys(NOT_A_CALLERS_ID).filter((k) => !counts.has(k))).toEqual(
      [],
    );
  });

  // The rule the tree cannot currently show, because every waived call happens to be the only one
  // of its spelling in its file. Without this, the count is untested and a second call slips in
  // under the first one's waiver.
  test("a waiver covers one call, not every call that reads the same", () => {
    const ledger = { "a.ts | raw": "argued for once" };
    expect(unwaived(new Map([["a.ts | raw", 1]]), ledger)).toEqual([]);
    expect(unwaived(new Map([["a.ts | raw", 2]]), ledger)).toEqual([
      "a.ts | raw (2 calls, 1 waived)",
    ]);
    expect(unwaived(new Map([["b.ts | raw", 1]]), ledger)).toEqual([
      "b.ts | raw",
    ]);
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

  // NOTE: the control: the extractor has to find the shapes this fence exists for, including the two a
  // name-based pattern cannot see, and leave the parses and the literals alone.
  test("the extractor finds every shape a cast can take", () => {
    expect(
      bigIntArgs(
        [
          "BigInt(params.id)",
          "agentId: b.agentId ? BigInt(b.agentId) : undefined,",
          "ids.map((s) => BigInt(s))",
          "ids.push(BigInt(r.slice(VAULT_REF_PREFIX.length)));",
          "BigInt(parts[2] as string)",
          "BigInt(\n  data.businessHoursId,\n)",
        ].join("\n"),
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

  // NOTE: an argument that STARTS with a literal is not a literal: judged by first character,
  // `BigInt("0" + params.id)` would be dropped as a constant while deriving its value from the path.
  test("only a wholly literal argument is dropped", () => {
    expect(
      bigIntArgs(
        [
          'BigInt("0" + params.id)',
          "BigInt(7n + offset)",
          "BigInt(`${raw}`)",
        ].join("\n"),
      ),
    ).toEqual(['"0" + params.id', "7n + offset", "`${raw}`"]);
  });

  // Two identical calls are two calls. A waiver covers one of them, and the sweep can only enforce
  // that if the extractor reports both rather than deduplicating them here.
  test("the same spelling twice is reported twice", () => {
    expect(bigIntArgs("BigInt(raw)\nBigInt(raw)")).toEqual(["raw", "raw"]);
  });

  // NOTE: a `${…}` hole is code, not text: the argument is caller-controlled either way, and the backtick
  // around it is incidental.
  test("a cast inside a template interpolation is still a cast", () => {
    expect(
      bigIntArgs("const key = `t:${BigInt(body.id)}:${BigInt(q.n)}`;"),
    ).toEqual(["body.id", "q.n"]);
    // NOTE: nested one deep, and the surrounding TEXT still counts as text: `BigInt(` in the literal
    // part is not a call, before the hole and after the last one alike (the chunk a walk that only
    // blanks on the way IN forgets).
    expect(
      bigIntArgs("`a BigInt(x) b ${ `${BigInt(raw)}` } c BigInt(z) d`"),
    ).toEqual(["raw"]);
    // NOTE: a brace inside the hole is the hole's, not its terminator. Miscounting it ends the hole at
    // the object's `}` and reads the rest of the line as text, which swallows the call after it.
    expect(bigIntArgs("`${ fn({ a: 1 }) + BigInt(body.id) }`")).toEqual([
      "body.id",
    ]);
  });

  // NOTE: a regex literal is neither code nor a comment opener. Wrong either way hides calls: `\\/\\/`
  // inside a pattern read as `//` blanks the rest of the line, and a pattern that spells the
  // forbidden call would be reported as a call nobody wrote.
  test("a regex literal is skipped, and does not swallow the line after it", () => {
    expect(
      bigIntArgs("const re = /https?:\\/\\//; const id = BigInt(body.id);"),
    ).toEqual(["body.id"]);
    // NOTE: both spellings of the call inside a pattern: escaped, as a sweep for it would write, and
    // unescaped, where the parens are a capture group and the text reads exactly like a call.
    expect(bigIntArgs("const OFFENDING = /BigInt\\(params\\.id\\)/;")).toEqual(
      [],
    );
    expect(bigIntArgs("const g = /BigInt(params.id)/;")).toEqual([]);
    // NOTE: a character class can hold an unescaped slash, so the scan has to leave the class before it
    // takes one for the closing delimiter.
    expect(bigIntArgs("const re = /[/x]+/; BigInt(q.n);")).toEqual(["q.n"]);
  });

  // …and division is not a regex. Reading `a / b` as one would swallow everything to the next
  // slash, which is how a scanner that guesses goes blind on ordinary arithmetic.
  test("division is left alone", () => {
    expect(bigIntArgs("const n = a / b; BigInt(c);")).toEqual(["c"]);
    expect(bigIntArgs("const n = fn(x) / 2; BigInt(d);")).toEqual(["d"]);
    expect(bigIntArgs("const n = arr[0] / 2; BigInt(e);")).toEqual(["e"]);
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
    expect(bigIntArgs(src)).toEqual([]);
  });

  // NOTE: …and a string INSIDE an argument survives verbatim, which is what keeps two waivers apart. The
  // blanking stops a quoted call from being found; erasing the argument's own text would collapse
  // every `slice("<prefix>".length)` in the tree onto one key.
  test("two calls differing only inside a string literal are two keys", () => {
    expect(
      bigIntArgs(
        [
          'BigInt(ref.slice("vault:".length))',
          'BigInt(ref.slice("other:".length))',
        ].join("\n"),
      ),
    ).toEqual(['ref.slice("vault:".length)', 'ref.slice("other:".length)']);
  });
});
