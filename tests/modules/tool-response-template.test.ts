import { describe, expect, test } from "bun:test";
import { buildToolPatch } from "@/modules/mcp/write-agents";
import {
  ABSENT_MARKER,
  EMPTY_LIST_MARKER,
  enclosingBlock,
  MAX_EACH_ITEMS,
  MAX_TEMPLATE_CHARS,
  MODEL_RESPONSE_CHAR_LIMIT,
  moreItemsMarker,
  parseTemplate,
  projectToolResponse,
  readResponseTemplate,
  readResponseTemplateResult,
  renderResponseTemplate,
  storableResponseTemplate,
  templateItemLeaves,
  templateLeaves,
  templateListAt,
  templateLists,
  templateNeedsBody,
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

// #459. One token addresses one value, so a response that is a list of unknown length (a product
// search, a slot lookup, an order history) could not be projected at all and kept the raw clip,
// with the invention risk #456 measured. A block repeats its content per item.
describe("a list block (#459)", () => {
  const render = (template: string, body: unknown) =>
    renderResponseTemplate({ template }, body);

  const BODY = {
    total: 3,
    resultados: [
      { nome: "Cadeira", preco: 199.9, tags: ["madeira", "oferta"] },
      { nome: "Mesa", preco: 899, tags: [] },
      { nome: "Luminária", preco: 120, desconto: 10 },
    ],
    horarios: ["09:00", "10:30"],
    vazio: [],
    nulo: null,
    objeto: { a: 1 },
  };

  test("repeats its content once per item, with paths relative to the item", () => {
    // The markers sit alone on their lines and take the lines with them: one line per item comes
    // out as one line per item, not with a blank between every two.
    expect(
      render(
        "Total: {{total}}\n{{#each resultados}}\n- {{nome}} — R$ {{preco}}\n{{/each}}\nFim",
        BODY,
      ).text,
    ).toBe(
      "Total: 3\n- Cadeira — R$ 199.9\n- Mesa — R$ 899\n- Luminária — R$ 120\nFim",
    );
  });

  test("{{.}} is the item of a list of scalars, and an inline block keeps its line", () => {
    expect(
      render("Horários: {{#each horarios}}{{.}}; {{/each}}fim", BODY).text,
    ).toBe("Horários: 09:00; 10:30; fim");
  });

  test("{{#each .}} walks a body that IS the list", () => {
    expect(render("{{#each .}}{{.}},{{/each}}", ["a", "b"]).text).toBe("a,b,");
    expect(
      render("{{#each .}}{{id}} {{/each}}", [{ id: 1 }, { id: 2 }]).text,
    ).toBe("1 2 ");
  });

  test("a token outside the block is absolute; the same name inside is relative", () => {
    const got = render("{{nome}}|{{#each resultados}}{{nome}}|{{/each}}", BODY);
    expect(got.text).toBe(`${ABSENT_MARKER}|Cadeira|Mesa|Luminária|`);
    expect(got.missing).toEqual(["nome"]);
  });

  test("a field an item lacks renders absent and is reported ONCE, at the first index lacking it", () => {
    // In-grammar, so the operator can paste `resultados.0.desconto` into the sample field and
    // see for themselves; deduped per field, or a fifty-row list would name it fifty times.
    const got = render(
      "{{#each resultados}}{{nome}}: {{desconto}}\n{{/each}}",
      BODY,
    );
    expect(got.text).toBe(
      `Cadeira: ${ABSENT_MARKER}\nMesa: ${ABSENT_MARKER}\nLuminária: 10\n`,
    );
    expect(got.missing).toEqual(["resultados.0.desconto"]);
  });

  test("{{.}} over a list of objects is reported at the item", () => {
    const got = render("{{#each resultados}}{{.}}{{/each}}", BODY);
    expect(got.text).toBe(ABSENT_MARKER.repeat(3));
    expect(got.missing).toEqual(["resultados.0"]);
  });

  test("an empty list renders its own marker and is not reported", () => {
    // "No results" is an answer, and a label followed by nothing is the gap the model fills.
    const got = render("Lista: {{#each vazio}}{{.}}{{/each}}", BODY);
    expect(got.text).toBe(`Lista: ${EMPTY_LIST_MARKER}`);
    expect(got.missing).toEqual([]);
  });

  test.each([
    ["an object", "objeto", ["objeto"]],
    ["a scalar", "total", ["total"]],
    ["a path that does not resolve", "nada", ["nada"]],
    // The path is right and the API answered with nothing: same rule as a scalar token.
    ["null", "nulo", []],
  ])("a block over %s renders absent, reported: %p", (_l, path, missing) => {
    expect(render(`{{#each ${path}}}x{{/each}}`, BODY)).toEqual({
      text: ABSENT_MARKER,
      missing,
    });
  });

  test("past MAX_EACH_ITEMS the rest is COUNTED, never dropped silently", () => {
    const items = Array.from({ length: MAX_EACH_ITEMS + 7 }, (_, i) => ({
      n: i,
    }));
    const got = render("{{#each .}}{{n}},{{/each}}", items);
    expect(
      got.text.endsWith(`${MAX_EACH_ITEMS - 1},${moreItemsMarker(7)}`),
    ).toBe(true);
    expect(got.text).not.toContain(`${MAX_EACH_ITEMS},`);
    expect(got.missing).toEqual([]);
    // Exactly at the bound: everything shown, nothing counted.
    expect(
      render("{{#each .}}{{n}},{{/each}}", items.slice(0, MAX_EACH_ITEMS)).text,
    ).not.toContain("more");
  });

  // Round 1 of review, finding 1. Fifty items of ~100 characters is 5,000, so the clip below
  // removed the last ten AND the count after them: the model read a list that simply ended.
  test("a block renders UNDER the clip, and the count of the rest survives it", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      descricao: "d".repeat(80),
    }));
    const got = render("{{#each .}}- #{{id}} {{descricao}}\n{{/each}}", items);
    expect(got.text.length).toBeLessThanOrEqual(MODEL_RESPONSE_CHAR_LIMIT);
    const shown = (got.text.match(/^- #/gm) ?? []).length;
    expect(shown).toBeGreaterThan(30);
    expect(shown).toBeLessThan(MAX_EACH_ITEMS);
    expect(got.text.endsWith(moreItemsMarker(100 - shown))).toBe(true);
    // The runtime's own clip is what it renders under, so a smaller one shows fewer.
    const small = renderResponseTemplate(
      { template: "{{#each .}}- #{{id}} {{descricao}}\n{{/each}}" },
      items,
      { maxChars: 400 },
    );
    expect(small.text.length).toBeLessThanOrEqual(400);
    expect((small.text.match(/^- #/gm) ?? []).length).toBeLessThan(shown);
    expect(small.text).toContain("more not shown)");
  });

  test("text before the block counts against the same budget", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    const lead = "x".repeat(MODEL_RESPONSE_CHAR_LIMIT - 40);
    const got = render(`${lead}\n{{#each .}}{{n}},{{/each}}`, items);
    expect(got.text.length).toBeLessThanOrEqual(MODEL_RESPONSE_CHAR_LIMIT);
    expect(got.text).toContain("more not shown)");
  });

  test("a miss inside an item the budget dropped is not reported", () => {
    const items = [
      { id: 1, x: "a" },
      { id: 2, x: "b" },
      { id: "3".repeat(30) },
    ];
    // Room for two items and the count, not for the third, which is the one lacking `x`.
    const got = renderResponseTemplate(
      { template: "{{#each .}}{{id}}{{x}};{{/each}}" },
      items,
      { maxChars: 30 },
    );
    expect(got.text).toBe(`1a;2b;${moreItemsMarker(1)}`);
    expect(got.missing).toEqual([]);
  });

  test("a root list labels its items by index alone", () => {
    // Round 1 of review, finding 2: `..0.name` is not a path the grammar accepts, and the label
    // exists to be pasted into the path fields.
    expect(render("{{#each .}}{{name}}{{/each}}", [{}]).missing).toEqual([
      "0.name",
    ]);
    expect(render("{{#each .}}{{.}}{{/each}}", [{}]).missing).toEqual(["0"]);
  });

  test("a block needs the body even with no token inside it", () => {
    expect(templateNeedsBody("{{#each a}}x{{/each}}")).toBe(true);
    expect(templateNeedsBody("{{a}}")).toBe(true);
    expect(templateNeedsBody("Done.")).toBe(false);
    // And the projection agrees: a body that is not JSON cannot say how many times to repeat.
    expect(
      projectToolResponse(
        { mode: "template", template: "{{#each a}}x{{/each}}" },
        200,
        "not json",
      ).skipped,
    ).toBe("not-json");
    expect(
      projectToolResponse(
        { mode: "template", template: "{{#each a}}x{{/each}}" },
        200,
        '{"a":[1,2]}',
      ).text,
    ).toBe("xx");
  });

  test("block markers are not tokens, and {{.}} is a usable one", () => {
    expect(templateTokens("{{#each a}}{{b}}{{/each}}{{c}}")).toEqual([
      "b",
      "c",
    ]);
    expect(unusableTemplateTokens("{{#each a}}{{.}} {{x y}}{{/each}}")).toEqual(
      ["x y"],
    );
  });

  test("the write schema accepts a block and refuses a broken one", () => {
    const base = {
      name: "search",
      label: "Search",
      urlTemplate: "https://example.com/x",
      allowedHosts: ["example.com"],
    };
    expect(
      toolDefinitionCreateSchema.safeParse({
        ...base,
        outputSchema: {
          mode: "template",
          template: "{{#each items}}- {{name}}\n{{/each}}",
        },
      }).success,
    ).toBe(true);
    expect(
      toolDefinitionCreateSchema.safeParse({
        ...base,
        outputSchema: {
          mode: "template",
          template: "{{#each items}}- {{name}}",
        },
      }).success,
    ).toBe(false);
  });
});

describe("parseTemplate refuses a broken structure, and the reader carries the reason", () => {
  test.each([
    ["an unclosed block", "{{#each a}}x", "no {{/each}} after it"],
    ["a close with no open", "x{{/each}}", "no {{#each …}} before it"],
    [
      "a nested block",
      "{{#each a}}{{#each b}}x{{/each}}{{/each}}",
      "cannot contain another",
    ],
    ["a block with no path", "{{#each}}x{{/each}}", "does not name a list"],
    [
      "a block with a malformed path",
      "{{#each a b}}x{{/each}}",
      "does not name a list",
    ],
  ])("%s", (_label, template, needle) => {
    expect(parseTemplate(template).problem).toContain(needle);
    const r = readResponseTemplateResult({ mode: "template", template });
    expect(r.declared && !r.ok ? r.problem : "").toContain(needle);
    expect(readResponseTemplate({ mode: "template", template })).toBeNull();
  });

  test("a marker alone on its line takes the line; one sharing a line keeps it", () => {
    expect(
      parseTemplate("a\n  {{#each x}}  \nb\n{{/each}}\nc").segments,
    ).toEqual([
      { kind: "text", text: "a\n" },
      { kind: "each", path: "x", body: "b\n" },
      { kind: "text", text: "c" },
    ]);
    expect(parseTemplate("a {{#each x}}b{{/each}} c").segments).toEqual([
      { kind: "text", text: "a " },
      { kind: "each", path: "x", body: "b" },
      { kind: "text", text: " c" },
    ]);
  });

  test("a standalone marker ending in \\r\\n takes the whole line, as with \\n", () => {
    // A template sent over REST or MCP from a Windows editor.
    expect(
      renderResponseTemplate(
        { template: "a\r\n{{#each xs}}\r\n- {{.}}\r\n{{/each}}\r\nb" },
        { xs: [1, 2] },
      ).text,
    ).toBe("a\r\n- 1\r\n- 2\r\nb");
  });

  test("{{.}} outside a block is the body itself, which is usually not a scalar", () => {
    // Consistent rather than refused: `.` is the current scope everywhere. A JSON scalar body is
    // the one case it renders.
    expect(renderResponseTemplate({ template: "{{.}}" }, "ok")).toEqual({
      text: "ok",
      missing: [],
    });
    expect(renderResponseTemplate({ template: "{{.}}" }, { a: 1 })).toEqual({
      text: ABSENT_MARKER,
      missing: ["."],
    });
  });
});

describe("what the picker offers for a block", () => {
  const BODY = {
    total: 3,
    resultados: [
      { nome: "Cadeira", preco: 199.9, tags: ["madeira", "oferta"] },
      { nome: "Mesa", preco: 899, tags: [] },
      { nome: "Luminária", preco: 120, desconto: 10 },
    ],
    horarios: ["09:00", "10:30"],
    vazio: [],
  };

  test("templateLists names every list with its length, the root as `.`", () => {
    expect(templateLists(BODY)).toEqual([
      { path: "resultados", length: 3 },
      { path: "resultados.0.tags", length: 2 },
      { path: "resultados.1.tags", length: 0 },
      { path: "horarios", length: 2 },
      { path: "vazio", length: 0 },
    ]);
    expect(templateLists([1, 2])).toEqual([{ path: ".", length: 2 }]);
    expect(templateLists({ a: 1 })).toEqual([]);
  });

  test("templateItemLeaves is the union over the first items, and every offer renders", () => {
    const items = templateListAt(BODY, "resultados");
    expect(items).not.toBeNull();
    const leaves = templateItemLeaves(items ?? []);
    // `desconto` is on the THIRD item only, and is still a field of the list.
    expect(leaves.map((l) => l.path)).toEqual([
      "nome",
      "preco",
      "tags.0",
      "tags.1",
      "desconto",
    ]);
    for (const leaf of leaves) {
      const rendered = renderResponseTemplate(
        { template: `{{#each resultados}}{{${leaf.path}}}|{{/each}}` },
        BODY,
      );
      expect(rendered.text.split("|")).toContain(leaf.value);
    }
    expect(templateItemLeaves(BODY.horarios)).toEqual([
      { path: ".", value: "09:00" },
    ]);
    expect(templateListAt(BODY, "total")).toBeNull();
    expect(templateListAt([1], ".")).toEqual([1]);
  });

  test("enclosingBlock answers by caret, and while the block is still unclosed", () => {
    const t = "a {{#each xs}} b {{/each}} c {{#each ys}} d";
    expect(enclosingBlock(t, 0)).toBeNull();
    // Inside the opening marker: not passed yet.
    expect(enclosingBlock(t, 5)).toBeNull();
    expect(enclosingBlock(t, t.indexOf(" b "))).toBe("xs");
    expect(enclosingBlock(t, t.indexOf(" c "))).toBeNull();
    // The operator just typed the marker and opened the picker: the block is unclosed, and the
    // item fields are exactly what they want.
    expect(enclosingBlock(t, t.length)).toBe("ys");
  });
});
