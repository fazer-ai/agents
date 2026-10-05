import { describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";

// A tool's server that trims its own answer to fit the limit says so with a header, and the platform
// reports it exactly as it reports its own clip: one `response_clipped` line.

const PUBLIC = "8.8.8.8";

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "catalogo",
    method: "GET",
    urlTemplate: `https://${PUBLIC}/v1/evento`,
    allowedHosts: [PUBLIC],
    headers: {},
    inputSchema: {},
    credentialRef: null,
    ...over,
  };
}

type Note = { phase: string; detail?: Record<string, unknown>; err: unknown };

async function call(
  body: string,
  headers: Record<string, string>,
  status = 200,
  over: Partial<HttpToolDef> = {},
) {
  const notes: Note[] = [];
  const tool = buildHttpTool(def(over), {
    resolveCredential: async () => null,
    fetchImpl: (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "text/plain", ...headers },
      })) as unknown as typeof fetch,
    onSideEffectError: (e) =>
      notes.push({ phase: e.phase, detail: e.detail, err: e.err }),
  });
  const out = (await tool.invoke({})) as unknown as ToolMessage | string;
  const text =
    typeof out === "string" ? out : String((out as ToolMessage).content);
  return { notes, text };
}

const SHORT = "Descrição do evento… [descrição encurtada]";

describe("an HTTP tool that declares its own trim", () => {
  test("a body under the limit with the header and the original size is reported as declared", async () => {
    const { notes, text } = await call(SHORT, { "X-Tool-Truncated": "18234" });
    expect(text).toBe(`HTTP 200\n${SHORT}`);
    expect(notes.map((n) => n.phase)).toEqual(["response_clipped"]);
    expect(notes[0]?.detail).toEqual({
      declared: true,
      chars: 18234,
      limit: 4000,
      templated: false,
    });
    expect(String((notes[0]?.err as Error | undefined)?.message)).toContain(
      "18234",
    );
  });

  test("the header without a usable size still declares the trim, with no size", async () => {
    for (const value of ["true", "", "-5", "12abc", "0"]) {
      const { notes } = await call(SHORT, { "X-Tool-Truncated": value });
      expect(notes.map((n) => n.detail)).toEqual([
        { declared: true, limit: 4000, templated: false },
      ]);
    }
  });

  test("the header name is matched case-insensitively", async () => {
    const { notes } = await call(SHORT, { "x-tool-truncated": "9000" });
    expect(notes[0]?.detail).toMatchObject({ declared: true, chars: 9000 });
  });

  test("a body past the limit that also declares a trim is ONE line: the platform's, marked declared", async () => {
    const big = "y".repeat(5000);
    const { notes, text } = await call(big, { "X-Tool-Truncated": "20000" });
    expect(text).toBe(`HTTP 200\n${"y".repeat(4000)}…[truncated]`);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.detail).toEqual({
      chars: 5000,
      limit: 4000,
      templated: false,
      skipped: "no-template",
      declared: true,
      declaredChars: 20000,
    });
  });

  test("a non-2xx answer that declares a trim is reported too: the model still read a cut text", async () => {
    const { notes } = await call(SHORT, { "X-Tool-Truncated": "7000" }, 500);
    expect(notes.find((n) => n.phase === "response_clipped")?.detail).toEqual({
      declared: true,
      chars: 7000,
      limit: 4000,
      templated: false,
    });
  });

  test("without the header nothing changes: a short body reports nothing, a long one the platform's clip", async () => {
    const short = await call(SHORT, {});
    expect(short.notes).toEqual([]);
    expect(short.text).toBe(`HTTP 200\n${SHORT}`);
    const long = await call("z".repeat(5000), {});
    expect(long.notes.map((n) => n.detail)).toEqual([
      { chars: 5000, limit: 4000, templated: false, skipped: "no-template" },
    ]);
  });
});
