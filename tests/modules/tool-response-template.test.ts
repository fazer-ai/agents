import { describe, expect, test } from "bun:test";
import { buildToolPatch } from "@/modules/mcp/write-agents";
import {
  ABSENT_MARKER,
  MAX_TEMPLATE_CHARS,
  readResponseTemplate,
  readResponseTemplateResult,
  renderResponseTemplate,
  storableResponseTemplate,
  templateLeaves,
  templateTokens,
  unmatchedTemplateDelimiter,
  unusableTemplateTokens,
} from "@/modules/tool-definitions/response-template";
import { toolDefinitionCreateSchema } from "@/modules/tool-definitions/service";

// The decision table for what an HTTP tool may declare about the shape its response reaches the
// model in (issue #456). The rule lives in one pure function; the DB-backed and runtime tests prove
// the wiring, never the rule.

describe("readResponseTemplateResult", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", [{ mode: "template", template: "x" }]],
    ["a string", "mode: template"],
    ["an empty object", {}],
    // THE back-compat case: `output_schema` has been writable through MCP since it existed, with no
    // validation and no reader, so a row may hold a real JSON Schema. It declares nothing, and the
    // write that puts it there is still accepted.
    [
      "a JSON Schema",
      { type: "object", properties: { id: { type: "string" } } },
    ],
    ["another mode", { mode: "fields", template: "{{a}}" }],
  ])("declares nothing for %s", (_label, raw) => {
    expect(readResponseTemplateResult(raw)).toEqual({ declared: false });
    expect(readResponseTemplate(raw)).toBeNull();
  });

  test("accepts a template and trims it", () => {
    expect(
      readResponseTemplateResult({
        mode: "template",
        template: "  Name: {{data.name}}\n  ",
      }),
    ).toEqual({
      declared: true,
      ok: true,
      template: "Name: {{data.name}}",
    });
  });

  test("accepts a template with no tokens at all", () => {
    // A write tool whose 3kB response the model has no use for: the operator says so in one line.
    expect(
      readResponseTemplate({ mode: "template", template: "Done." }),
    ).toEqual({
      template: "Done.",
    });
  });

  // Declared-and-broken is REFUSED, never stored-and-ignored: the operator wrote it and is the one
  // who can fix it, and a declaration that looks saved and does nothing is the silence #456 removes.
  test.each([
    [
      "a non-string template",
      { mode: "template", template: 42 },
      "must be a string",
    ],
    [
      "an empty template",
      { mode: "template", template: "   " },
      "must not be empty",
    ],
    [
      "an over-long template",
      { mode: "template", template: "x".repeat(MAX_TEMPLATE_CHARS + 1) },
      "at most",
    ],
    [
      "a NUL in the template",
      { mode: "template", template: "Name: \u0000 {{a}}" },
      "cannot be stored",
    ],
    [
      "a malformed token",
      { mode: "template", template: "Name: {{data. name}}" },
      "{{data. name}}",
    ],
    [
      "an empty token",
      { mode: "template", template: "Name: {{}}" },
      "not a path into the response",
    ],
  ])("refuses %s", (_label, raw, needle) => {
    const r = readResponseTemplateResult(raw);
    expect(r.declared).toBe(true);
    expect(r.declared && r.ok).toBe(false);
    expect(r.declared && !r.ok ? r.problem : "").toContain(needle as string);
    // And the runtime reader agrees: nothing to honour.
    expect(readResponseTemplate(raw)).toBeNull();
  });

  test("the write schema refuses exactly what the reader refuses", () => {
    const base = {
      name: "lookup",
      label: "Lookup",
      urlTemplate: "https://example.com/x",
      allowedHosts: ["example.com"],
    };
    expect(
      toolDefinitionCreateSchema.safeParse({
        ...base,
        outputSchema: { mode: "template", template: "{{data. name}}" },
      }).success,
    ).toBe(false);
    expect(
      toolDefinitionCreateSchema.safeParse({
        ...base,
        outputSchema: { mode: "template", template: "Name: {{data.name}}" },
      }).success,
    ).toBe(true);
    // The legacy shape still writes.
    expect(
      toolDefinitionCreateSchema.safeParse({
        ...base,
        outputSchema: { type: "object", properties: {} },
      }).success,
    ).toBe(true);
  });
});

describe("templateTokens", () => {
  test("lists tokens in document order, deduped, malformed included", () => {
    expect(templateTokens("{{b}} {{ a.0.c }} {{b}} {{x y}}")).toEqual([
      "b",
      "a.0.c",
      "x y",
    ]);
  });

  test("unusableTemplateTokens names only the ones the grammar refuses", () => {
    expect(unusableTemplateTokens("{{a.b}} {{a..b}} {{}} {{ok_1}}")).toEqual([
      "a..b",
      "",
    ]);
  });
});

describe("renderResponseTemplate", () => {
  const render = (template: string, body: unknown) =>
    renderResponseTemplate({ template }, body);

  const BODY = {
    razao_social: "MAGAZINE LUIZA S/A",
    capital_social: 4_000_000,
    opcao_pelo_simples: false,
    complemento: "",
    baixado_em: null,
    qsa: [{ nome: "SOCIO UM" }, { nome: "SOCIO DOIS" }],
    endereco: { municipio: "FRANCA" },
  };

  test("renders scalars, a nested key and an array position", () => {
    expect(
      render(
        "**{{razao_social}}** — {{endereco.municipio}}\nSócio: {{qsa.0.nome}}",
        BODY,
      ).text,
    ).toBe("**MAGAZINE LUIZA S/A** — FRANCA\nSócio: SOCIO UM");
  });

  test("renders a number and, unlike the appointment reader, a boolean", () => {
    // `false` is an ANSWER. Rendering it absent would hand the model a blank where the API said no.
    expect(render("{{capital_social}}/{{opcao_pelo_simples}}", BODY).text).toBe(
      "4000000/false",
    );
  });

  test("a path that does not resolve renders the marker AND is reported", () => {
    const got = render("Situação: {{situacao}}\nUF: {{endereco.uf}}", BODY);
    expect(got.text).toBe(`Situação: ${ABSENT_MARKER}\nUF: ${ABSENT_MARKER}`);
    expect(got.missing).toEqual(["situacao", "endereco.uf"]);
  });

  test("a path aimed at an object or an array is reported, not coerced", () => {
    const got = render("{{qsa}} {{endereco}}", BODY);
    expect(got.text).toBe(`${ABSENT_MARKER} ${ABSENT_MARKER}`);
    expect(got.missing).toEqual(["qsa", "endereco"]);
  });

  test("null and the empty string render absent but are NOT reported", () => {
    // The path is right; the API answered with nothing. Sending the operator to fix a correct
    // template is as wrong as leaving a blank for the model to fill.
    const got = render("{{baixado_em}}|{{complemento}}", BODY);
    expect(got.text).toBe(`${ABSENT_MARKER}|${ABSENT_MARKER}`);
    expect(got.missing).toEqual([]);
  });

  test("a repeated missing path is reported once", () => {
    expect(render("{{a}} {{a}} {{a}}", BODY).missing).toEqual(["a"]);
  });

  test("a number past 2^53 is refused rather than shown rounded", () => {
    // JSON.parse already lost the digits; String() would show the model an id nothing issued, and a
    // model that reads an id in a tool result passes it to the next call.
    const got = render("{{id}}", JSON.parse('{"id": 9007199254740993}'));
    expect(got.text).toBe(ABSENT_MARKER);
    expect(got.missing).toEqual(["id"]);
  });

  test("one long value is cut where it happens, so the fields after it survive", () => {
    const got = render("A: {{long}}\nB: {{b}}", {
      long: "x".repeat(2500),
      b: "kept",
    });
    expect(got.text).toContain("…[truncated]");
    expect(got.text.endsWith("\nB: kept")).toBe(true);
    expect(got.missing).toEqual([]);
  });

  test("{{secret}} is a path into the RESPONSE and never the credential", () => {
    // The request-side vocabulary does not exist here. `secret` resolves in the body like any other
    // key, finds nothing, and renders absent.
    expect(render("{{secret}}|{{contact_name}}", BODY).text).toBe(
      `${ABSENT_MARKER}|${ABSENT_MARKER}`,
    );
  });

  test("a non-object body resolves nothing", () => {
    expect(render("{{a}}", "plain text").text).toBe(ABSENT_MARKER);
    expect(render("{{a}}", null).text).toBe(ABSENT_MARKER);
  });
});

describe("templateLeaves", () => {
  test("offers exactly what the renderer accepts, and every offer round-trips", () => {
    const body = {
      name: "ACME",
      active: false,
      count: 3,
      empty: "",
      nothing: null,
      nested: { list: [{ id: "a1" }] },
    };
    const leaves = templateLeaves(body);
    expect(leaves.map((l) => l.path)).toEqual([
      "name",
      "active",
      "count",
      "empty",
      "nested.list.0.id",
    ]);
    for (const leaf of leaves) {
      const rendered = renderResponseTemplate(
        { template: `{{${leaf.path}}}` },
        body,
      );
      // An empty value renders as the marker, but it is still a path the renderer resolved: nothing
      // is reported for it. That is the only place the offer and the render text differ.
      expect(rendered.missing).toEqual([]);
      if (leaf.value !== "") expect(rendered.text).toBe(leaf.value);
    }
  });
});

// Round 4 of review, finding 2. A `{{` or `}}` that is not part of a token is invisible to the token
// scan — `{{a}` matches nothing, so it is not an unusable TOKEN, it is not a token at all — and the
// declaration was accepted, stored, and put in front of the model verbatim.
describe("unmatchedTemplateDelimiter", () => {
  test.each([
    ["Name: {{data.name}", "{{data.name}"],
    ["Name: {data.name}}", "}}"],
    ["ok {{a}} and {{ left over", "{{ left over"],
    ["{{a}} }}", "}}"],
  ])("%p is refused, pointing at %p", (template, near) => {
    expect(unmatchedTemplateDelimiter(template)).toBe(near);
    const read = readResponseTemplateResult({ mode: "template", template });
    expect(read.declared && read.ok).toBe(false);
    expect(read.declared && !read.ok ? read.problem : "").toContain(
      "unmatched delimiter",
    );
  });

  test.each([
    "Name: {{data.name}}",
    // A single brace is not this vocabulary's, so it is content and stays content.
    'A JSON body looks like { "a": 1 }',
    "Nothing to interpolate here.",
    "{{a}} {{b.0.c}}",
  ])("%p is left alone", (template) => {
    expect(unmatchedTemplateDelimiter(template)).toBeNull();
    const read = readResponseTemplateResult({ mode: "template", template });
    expect(read.declared && read.ok).toBe(true);
  });
});

// Round 10 of review, finding 2. `tool_create` / `tool_update` have a dry run, and a dry run never
// calls the service — so whatever this function puts in the patch is what the caller reads in the
// preview and the diff, and then applies. The service stores what `storableResponseTemplate` makes
// of the argument, so echoing the argument back promises a value that will not be stored.
//
// The same lesson the `body` check one line below already carries from issue #150, and the reason
// it is a test rather than a comment: round 1 of this review showed a fix that only the call site
// could prove.
describe("the MCP dry run previews what the apply would store", () => {
  const ctx = {
    tenantId: 1n,
    userId: null,
    role: "TENANT_ADMIN",
  } as unknown as Parameters<typeof buildToolPatch>[0];
  const noDb = {} as Parameters<typeof buildToolPatch>[2];

  test.each([
    [
      "a padded template",
      { mode: "template", template: "  Empresa: {{razao_social}}  " },
    ],
    [
      "extra keys beside the declaration",
      { mode: "template", template: "Done.", note: "ignored", extra: 1 },
    ],
    ["a plain template", { mode: "template", template: "Done." }],
    // Not a template declaration at all: it has to survive untouched, which is the other half.
    ["a legacy JSON Schema", { type: "object", properties: { id: {} } }],
  ])("%s", async (_label, output_schema) => {
    const got = await buildToolPatch(ctx, { output_schema } as never, noDb);
    expect("patch" in got).toBe(true);
    const previewed = (got as { patch: { outputSchema?: unknown } }).patch
      .outputSchema;
    // Not "looks canonical": the very value the write path would store.
    expect(previewed).toEqual(storableResponseTemplate(output_schema));
  });
});
