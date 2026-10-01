/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import {
  formFromTool,
  insertEachBlock,
  nativeVarItems,
  outputSchemaForm,
  parseExpectedStatuses,
  parseMaxResponseChars,
  payloadOf,
  type Tool,
  templatePreviewFor,
  templateSaveProblem,
  testFieldsFrom,
} from "@/client/pages/resources/ToolEditModal";
import { buildHttpTool } from "@/graph/tools/http";
import {
  CONTEXT_VAR_NAMES,
  HTTP_TOOL_ONLY_VAR_NAMES,
} from "@/modules/tool-definitions/normalize";
import { MAX_TEMPLATE_CHARS } from "@/modules/tool-definitions/response-template";
import { toolDefinitionCreateSchema } from "@/modules/tool-definitions/service";

// NOTE: formFromTool is pure over its argument; these tests exercise the legacy load path without
// rendering the modal.

function legacyTool(over: Partial<Tool> = {}): Tool {
  return {
    id: "1",
    name: "legacy",
    label: "Legacy",
    description: null,
    method: "GET",
    urlTemplate: "https://api.example.com/accounts/{{tenant}}",
    allowedHosts: ["api.example.com"],
    headers: {},
    inputSchema: {},
    outputSchema: {},
    query: {},
    body: {},
    credentialRef: null,
    enabled: true,
    ackEnabled: false,
    ackMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as Tool;
}

describe("formFromTool — legacy fixed URL bindings", () => {
  test("a fixed field bound to a URL placeholder is inlined so saving cannot drop it", () => {
    const form = formFromTool(
      legacyTool({
        inputSchema: {
          tenant: { source: "fixed", value: "acme" },
          q: { type: "string", required: true },
        },
      }),
    );
    // NOTE: the visible URL carries the effective value; no orphan {{tenant}} token survives a
    // save that only writes AI fields.
    expect(form.urlTemplate).toBe("https://api.example.com/accounts/acme");
    expect(form.aiFields.map((f) => f.name)).toEqual(["q"]);
  });

  test("a fixed URL binding whose value is a context template stays a template", () => {
    const form = formFromTool(
      legacyTool({
        inputSchema: {
          tenant: { source: "fixed", value: "{{conversation_id}}" },
        },
      }),
    );
    expect(form.urlTemplate).toBe(
      "https://api.example.com/accounts/{{conversation_id}}",
    );
  });

  test("an AI field bound to a URL placeholder keeps its {{token}} and its schema row", () => {
    const form = formFromTool(
      legacyTool({
        inputSchema: { tenant: { type: "string", required: true } },
      }),
    );
    expect(form.urlTemplate).toBe(
      "https://api.example.com/accounts/{{tenant}}",
    );
    expect(form.aiFields.map((f) => f.name)).toEqual(["tenant"]);
  });
});

// The operator types a list; the server normalizes it (dedupe, sort, drop 2xx and out-of-range).
// The field is permissive on purpose: a stray separator is not worth failing a save.
describe("parseExpectedStatuses", () => {
  test("an empty field declares nothing, which is the fail-closed default", () => {
    expect(parseExpectedStatuses("")).toEqual([]);
    expect(parseExpectedStatuses("   ")).toEqual([]);
  });

  test("a comma list becomes numbers", () => {
    expect(parseExpectedStatuses("404, 409")).toEqual([404, 409]);
  });

  test("spaces, semicolons and trailing separators are all accepted", () => {
    expect(parseExpectedStatuses("404 409; 410,")).toEqual([404, 409, 410]);
  });

  test("what is not a whole positive number is dropped rather than rejected", () => {
    expect(parseExpectedStatuses("404, abc, 4.5, -1")).toEqual([404]);
  });

  // Round-trip: the stored list is rendered back into the field as a comma list.
  test("the rendered value parses back to itself", () => {
    expect(parseExpectedStatuses([404, 409].join(", "))).toEqual([404, 409]);
  });
});

// The response template travels through the form as plain markdown; the {mode, template}
// envelope is assembled on save, and whatever ELSE the column held has to survive an edit that
// never showed it.
describe("formFromTool / payloadOf — the response template", () => {
  test("a stored template loads as the text the operator wrote", () => {
    const form = formFromTool(
      legacyTool({
        outputSchema: { mode: "template", template: "Name: {{data.name}}" },
      }),
    );
    expect(form.outputTemplate).toBe("Name: {{data.name}}");
    expect(form.outputSchemaOther).toBeNull();
    expect(payloadOf(form)?.outputSchema).toEqual({
      mode: "template",
      template: "Name: {{data.name}}",
    });
  });

  test("a legacy JSON Schema is not shown, and is not deleted either", () => {
    // This column has been writable through MCP since it existed, unvalidated and read nowhere. A
    // form that renders nothing for it and sends {} on save would silently drop whatever the caller
    // that wrote it is still reading back.
    const schema = { type: "object", properties: { id: { type: "string" } } };
    const form = formFromTool(legacyTool({ outputSchema: schema }));
    expect(form.outputTemplate).toBe("");
    expect(payloadOf(form)?.outputSchema).toEqual(schema);
  });

  test("writing a template replaces whatever was there", () => {
    const form = formFromTool(legacyTool({ outputSchema: { type: "object" } }));
    expect(
      payloadOf({ ...form, outputTemplate: "  {{a}}  " })?.outputSchema,
    ).toEqual({
      mode: "template",
      template: "{{a}}",
    });
  });

  test("a tool with no outputSchema still sends an empty bag", () => {
    const form = formFromTool(legacyTool());
    expect(payloadOf(form)?.outputSchema).toEqual({});
  });
});

// The preview is labelled "exactly what the agent would receive", and the runtime projects the
// template on 2xx ALONE, so a sample from a status outside that range must not be previewed as
// projected. The control is agreement with `buildHttpTool`, not with this file's reading of it:
// each case runs the same definition through the runtime and compares.
describe("templatePreviewFor", () => {
  const BODY = {
    razao_social: "MAGAZINE LUIZA S/A",
    message: "não encontrado",
  };
  const SAMPLE = JSON.stringify(BODY);
  const TEMPLATE = "Empresa: {{razao_social}}";

  // What the runtime hands the model for this definition at this status, minus the "HTTP n" line
  // the preview box does not show.
  async function runtimeText(status: number, body = SAMPLE): Promise<string> {
    const tool = buildHttpTool(
      {
        name: "t",
        method: "GET",
        urlTemplate: "https://8.8.8.8/v1/x",
        allowedHosts: ["8.8.8.8"],
        headers: {},
        inputSchema: {},
        expectedStatuses: [status],
        credentialRef: null,
        credentialKind: null,
        credentialParamName: null,
        credentialBaseUrl: null,
        ackMessage: null,
        outputSchema: { mode: "template", template: TEMPLATE },
      },
      {
        resolveCredential: async () => null,
        fetchImpl: (async () =>
          new Response(body, {
            status,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );
    return String(await tool.invoke({}))
      .split("\n")
      .slice(1)
      .join("\n");
  }

  test.each([200, 201, 404, 500])(
    "matches what the runtime hands the model at HTTP %i",
    async (status) => {
      const preview = templatePreviewFor({
        template: TEMPLATE,
        sample: SAMPLE,
        status,
      });
      expect(preview?.text).toBe(await runtimeText(status));
      expect(preview?.skipped).toBe(
        status >= 200 && status < 300 ? null : "not-2xx",
      );
    },
  );

  test("a hand-pasted sample has no status and is previewed as a success", () => {
    // Nobody pastes an error body to design a success template against, so null reads as 2xx.
    expect(
      templatePreviewFor({
        template: TEMPLATE,
        sample: SAMPLE,
        status: null,
      }),
    ).toEqual({
      skipped: null,
      text: "Empresa: MAGAZINE LUIZA S/A",
      missing: [],
    });
  });

  test("nothing to preview without a template, or without a sample to render against", () => {
    expect(
      templatePreviewFor({ template: "   ", sample: SAMPLE, status: 200 }),
    ).toBeNull();
    expect(
      templatePreviewFor({ template: TEMPLATE, sample: "", status: 200 }),
    ).toBeNull();
    // A declaration the reader refuses gets its own message under the box, not a preview of what a
    // template that cannot be saved would have done.
    expect(
      templatePreviewFor({
        template: "Name: {{data..name}}",
        sample: SAMPLE,
        status: 200,
      }),
    ).toBeNull();
  });

  test("a non-2xx sample past the model's limit is previewed clipped, as the runtime clips it", async () => {
    const big = JSON.stringify({ message: "x".repeat(5000) });
    const preview = templatePreviewFor({
      template: TEMPLATE,
      sample: big,
      status: 502,
    });
    expect(preview?.text).toContain("…[truncated]");
    // Not "clipped somehow": clipped to the same string, by the same rule.
    expect(preview?.text).toBe(await runtimeText(502, big));
  });
});

// A legacy row can hold `{mode:"template", template:42}`, a declaration the reader refuses (MCP
// `tool_create` once stored `outputSchema` unvalidated). Kept verbatim, the editor would resend the
// broken object on every save and the service would reject it, locking the tool with no reason.
describe("outputSchemaForm", () => {
  test("a broken template declaration is dropped, with the reader's own reason", () => {
    const got = outputSchemaForm({ mode: "template", template: 42 });
    expect(got.outputTemplate).toBe("");
    // NOTE: resending it is what would lock the tool.
    expect(got.outputSchemaOther).toBeNull();
    expect(got.outputSchemaProblem).toContain("must be a string");
  });

  test("and the save that follows is one the service accepts", () => {
    const form = formFromTool(
      legacyTool({
        outputSchema: { mode: "template", template: 42 },
      } as never),
    );
    const sent = payloadOf(form)?.outputSchema;
    expect(sent).toEqual({});
    // Not this file's opinion of "accepts": the service's own schema.
    expect(
      toolDefinitionCreateSchema.safeParse({
        name: "t",
        label: "T",
        urlTemplate: "https://api.example.com/x",
        allowedHosts: ["api.example.com"],
        outputSchema: sent,
      }).success,
    ).toBe(true);
    expect(
      toolDefinitionCreateSchema.safeParse({
        name: "t",
        label: "T",
        urlTemplate: "https://api.example.com/x",
        allowedHosts: ["api.example.com"],
        outputSchema: { mode: "template", template: 42 },
      }).success,
    ).toBe(false);
  });

  test("a legacy JSON Schema is NOT a template declaration, and survives untouched", () => {
    // The other side of the same fork: this one has to come back out of a save that never showed it.
    const legacy = { type: "object", properties: { id: { type: "string" } } };
    const got = outputSchemaForm(legacy);
    expect(got.outputTemplate).toBe("");
    expect(got.outputSchemaOther).toEqual(legacy);
    expect(got.outputSchemaProblem).toBeNull();
    const form = formFromTool(legacyTool({ outputSchema: legacy } as never));
    expect(payloadOf(form)?.outputSchema).toEqual(legacy);
  });

  test("a readable template is the box's content and nothing is held back", () => {
    const got = outputSchemaForm({
      mode: "template",
      template: "Name: {{data.name}}",
    });
    expect(got.outputTemplate).toBe("Name: {{data.name}}");
    expect(got.outputSchemaOther).toBeNull();
    expect(got.outputSchemaProblem).toBeNull();
  });
});

// The preview calls `projectToolResponse` instead of restating the runtime's rules, so a rule the
// runtime learns cannot leave the preview behind. These are three cases a restatement gets wrong.
describe("templatePreviewFor — the rules are the runtime's, not a copy", () => {
  const TPL = "Empresa: {{razao_social}}";

  async function runtimeText(
    status: number,
    body: string | null,
    template = TPL,
  ): Promise<string> {
    const tool = buildHttpTool(
      {
        name: "t",
        method: "GET",
        urlTemplate: "https://8.8.8.8/v1/x",
        allowedHosts: ["8.8.8.8"],
        headers: {},
        inputSchema: {},
        expectedStatuses: [status],
        credentialRef: null,
        credentialKind: null,
        credentialParamName: null,
        credentialBaseUrl: null,
        ackMessage: null,
        outputSchema: { mode: "template", template },
      },
      {
        resolveCredential: async () => null,
        fetchImpl: (async () =>
          new Response(body, { status })) as unknown as typeof fetch,
      },
    );
    return String(await tool.invoke({}))
      .split("\n")
      .slice(1)
      .join("\n");
  }

  test("a render that overruns the model's limit is previewed clipped", async () => {
    // Two 2,000-character fields and a separator: the substitutions, not the template, are
    // what overrun. The runtime clips the PROJECTED body too, so the preview must as well.
    const body = JSON.stringify({ a: "x".repeat(2000), b: "y".repeat(2000) });
    const template = "{{a}}\n---\n{{b}}";
    const preview = templatePreviewFor({ template, sample: body, status: 200 });
    expect(preview?.skipped).toBeNull();
    expect(preview?.text).toContain("…[truncated]");
    expect(preview?.text).toBe(await runtimeText(200, body, template));
  });

  test("a token-less template is previewed for a 204 with no body at all", async () => {
    // The sample field is EMPTY here, and still there is a preview: the runtime hands the
    // model the operator's own text.
    const preview = templatePreviewFor({
      template: "Done. The booking is confirmed.",
      sample: "",
      status: 204,
    });
    expect(preview?.skipped).toBeNull();
    expect(preview?.text).toBe(
      await runtimeText(204, null, "Done. The booking is confirmed."),
    );
  });

  test("a body that is not JSON is previewed raw, as the runtime sends it", async () => {
    const preview = templatePreviewFor({
      template: TPL,
      sample: "not json at all",
      status: 200,
    });
    // NOTE: a preview, for a call that succeeds and reaches the model, and the REASON travels with
    // it: collapsed to a boolean, this case would render the non-2xx sentence for a 200.
    expect(preview?.skipped).toBe("not-json");
    expect(preview?.text).toBe(await runtimeText(200, "not json at all"));
  });
});

// Two more places where the console must ask the runtime rather than restate its rule.
describe("templatePreviewFor — the raw body is the raw body", () => {
  test("leading whitespace is not trimmed away before the clip", async () => {
    // On the raw path the runtime clips the body EXACTLY as it arrived, so trimming here slides the
    // 4,000-character window and shows tail content the model never reaches.
    const body = `${" ".repeat(200)}${"x".repeat(4000)}TAIL`;
    const preview = templatePreviewFor({
      template: "Empresa: {{razao_social}}",
      sample: body,
      status: 502,
    });
    expect(preview?.skipped).toBe("not-2xx");
    const tool = buildHttpTool(
      {
        name: "t",
        method: "GET",
        urlTemplate: "https://8.8.8.8/v1/x",
        allowedHosts: ["8.8.8.8"],
        headers: {},
        inputSchema: {},
        expectedStatuses: [502],
        credentialRef: null,
        credentialKind: null,
        credentialParamName: null,
        credentialBaseUrl: null,
        ackMessage: null,
        outputSchema: {
          mode: "template",
          template: "Empresa: {{razao_social}}",
        },
      },
      {
        resolveCredential: async () => null,
        fetchImpl: (async () =>
          new Response(body, { status: 502 })) as unknown as typeof fetch,
      },
    );
    const runtime = String(await tool.invoke({}))
      .split("\n")
      .slice(1)
      .join("\n");
    expect(preview?.text).toBe(runtime);
    // And the difference is observable, not theoretical: the trimmed version reaches TAIL.
    expect(preview?.text).not.toContain("TAIL");
  });
});

// The service refines with the WHOLE reader (which also refuses a template past the character limit
// and one carrying a NUL or a lone surrogate), so Save must gate on the same answer. The test is
// the agreement itself: each shape goes through the console's gate and the service's schema and
// must get the same answer.
describe("templateSaveProblem agrees with the service, shape for shape", () => {
  const NUL = String.fromCharCode(0);
  const CASES: [string, string][] = [
    ["a plain template", "Empresa: {{razao_social}}"],
    ["a constant", "Done."],
    ["an unusable token", "Name: {{data..name}}"],
    ["a stray brace", "Name: {{data.name}"],
    ["past the character limit", "x".repeat(MAX_TEMPLATE_CHARS + 1)],
    ["exactly at the limit", "x".repeat(MAX_TEMPLATE_CHARS)],
    ["a NUL", `a${NUL}b`],
    ["a lone surrogate", "a\ud800b"],
  ];

  test.each(CASES)("%s", (_label, template) => {
    const consoleSaysOk = templateSaveProblem(template) === null;
    const serverSaysOk = toolDefinitionCreateSchema.safeParse({
      name: "t",
      label: "T",
      urlTemplate: "https://api.example.com/x",
      allowedHosts: ["api.example.com"],
      outputSchema: { mode: "template", template },
    }).success;
    expect(consoleSaysOk).toBe(serverSaysOk);
  });
});

// The server refuses a declared template it would not honour (400), so a Test button that ignores
// the same check spends a REAL request against the operator's provider to be told what the box
// already knew. Asserted at the source because the alternative is mounting the whole editor.
test("the Test button is gated on the same template check Save is", async () => {
  const src = await Bun.file(
    "src/client/pages/resources/ToolEditModal.tsx",
  ).text();
  const button = src.slice(src.indexOf("tools.testOpen") - 900);
  const disabled = button.slice(0, button.indexOf("onClick={openTest}"));
  expect(disabled).toContain("templateDeclProblem");
  // And it is the READER's verdict both places, never a second phrasing of the rule.
  expect(src).toMatch(/templateDeclProblem\s*=\s*useMemo/);
});

// The runtime has three outcomes, not a boolean: a 2xx response that is not JSON (a CSV, an XML, a
// plain "OK") must not be explained as "outside 2xx", with the status interpolated as `null` when
// the sample was pasted by hand.
test("the preview names WHY the template did not apply, one branch per reason", async () => {
  const src = await Bun.file(
    "src/client/pages/resources/ToolEditModal.tsx",
  ).text();
  // Each reason the runtime can return has its own sentence, selected by that reason.
  expect(src).toMatch(
    /templatePreview\?\.skipped === "not-2xx"[\s\S]{0,400}outputTemplateNotApplied/,
  );
  expect(src).toMatch(
    /templatePreview\?\.skipped === "not-json"[\s\S]{0,400}outputTemplateNotJson/,
  );
  // NOTE: and never on the negation of "it rendered", which makes one sentence cover two causes.
  expect(src).not.toContain("!templatePreview.projected");
});

// The dialog runs the definition `payloadOf` produced, so its boxes come from that definition, not
// from the raw form rows. Those disagree wherever two rows trim to one name (which the editor
// permits): `schemaFromAiFields` writes an object, so the last declaration wins. Two boxes on one
// `ai:<name>` slot would let an earlier row's `required` or type judge a value the saved definition
// never declares.
test("the test dialog's boxes come from the definition it will send", () => {
  const form = formFromTool(legacyTool());
  const withDupes = {
    ...form,
    aiFields: [
      {
        _id: "a",
        name: "qty",
        type: "integer" as const,
        required: true,
        description: "first",
        enumValues: [] as string[],
        itemType: "string" as const,
      },
      {
        // Same name once trimmed. `payloadOf` keeps this one.
        _id: "b",
        name: "  qty  ",
        type: "string" as const,
        required: false,
        description: "second",
        enumValues: [] as string[],
        itemType: "string" as const,
      },
    ],
  };
  const payload = payloadOf(withDupes as never);
  const schema = payload?.inputSchema as Record<string, unknown>;
  expect(Object.keys(schema)).toEqual(["qty"]);
  const fields = testFieldsFrom(schema);
  expect(fields).toHaveLength(1);
  expect(fields[0]).toMatchObject({
    name: "qty",
    type: "string",
    required: false,
    description: "second",
  });
});

test("a legacy fixed field gets no box: it is not the model's to supply", () => {
  // `testFieldsFrom` reads `inputSchema`, and a STORED one can carry `source: "fixed"` entries —
  // the legacy placement shape the editor renders as literal rows instead. The runtime leaves them
  // out of the schema it validates against (`parseToolInputSchema` keeps `source === "ai"` only),
  // so a box here would collect a value the model never sends and the request never carries.
  expect(
    testFieldsFrom({
      qty: { type: "integer", required: true },
      api_version: { source: "fixed", value: "2024-01" },
    }),
  ).toEqual([
    { name: "qty", description: "", required: true, type: "integer" },
  ]);
});

test("and the dialog is built from that reader, not from the form rows", async () => {
  const src = await Bun.file(
    "src/client/pages/resources/ToolEditModal.tsx",
  ).text();
  expect(src).toMatch(/aiFields: testFieldsFrom\(/);
  // NOTE: the form rows disagree with the payload, so they must not be the source here.
  expect(src).not.toMatch(/aiFields: form\.aiFields/);
});

// A relative urlTemplate with no credential base is refused by `buildHttpTool` before a request
// goes out, and Save already knows: `urlTemplateInvalid` is deliberately false for that shape
// because `relativeWithoutBase` carries it separately. The Test button must read both halves too.
test("the Test button carries the whole URL gate Save does", async () => {
  const src = await Bun.file(
    "src/client/pages/resources/ToolEditModal.tsx",
  ).text();
  const at = src.indexOf("tools.testOpen");
  const disabled = src.slice(at - 1200, at).slice(-900);
  for (const cond of [
    "urlTemplateInvalid",
    "relativeWithoutBase",
    "templateDeclProblem",
  ]) {
    expect(disabled).toContain(cond);
  }
});

// The preview promises "exactly what the agent would receive", and a block is the one
// construct whose output depends on how MANY of something came back, so the control is the same
// as for a scalar template: agreement with `buildHttpTool` on the same definition and body.
describe("templatePreviewFor with a list block", () => {
  const BODY = {
    total: 2,
    itens: [
      { nome: "Cadeira", preco: 199.9 },
      { nome: "Mesa", preco: 899 },
    ],
  };
  const SAMPLE = JSON.stringify(BODY);
  const TEMPLATE =
    "{{total}} itens:\n{{#each itens}}\n- {{nome}}: R$ {{preco}}\n{{/each}}";

  async function runtimeText(status: number, body = SAMPLE): Promise<string> {
    const tool = buildHttpTool(
      {
        name: "t",
        method: "GET",
        urlTemplate: "https://8.8.8.8/v1/x",
        allowedHosts: ["8.8.8.8"],
        headers: {},
        inputSchema: {},
        expectedStatuses: [status],
        credentialRef: null,
        credentialKind: null,
        credentialParamName: null,
        credentialBaseUrl: null,
        ackMessage: null,
        outputSchema: { mode: "template", template: TEMPLATE },
      },
      {
        resolveCredential: async () => null,
        fetchImpl: (async () =>
          new Response(body, {
            status,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );
    return String(await tool.invoke({}))
      .split("\n")
      .slice(1)
      .join("\n");
  }

  test("renders one line per item, exactly as the runtime does", async () => {
    const preview = templatePreviewFor({
      template: TEMPLATE,
      sample: SAMPLE,
      status: 200,
    });
    expect(preview?.text).toBe(
      "2 itens:\n- Cadeira: R$ 199.9\n- Mesa: R$ 899\n",
    );
    expect(preview?.text).toBe(await runtimeText(200));
    expect(preview?.missing).toEqual([]);
  });

  test("a field an item lacks is named in-grammar, at the item that lacks it", () => {
    const preview = templatePreviewFor({
      template: TEMPLATE,
      sample: JSON.stringify({ total: 1, itens: [{ nome: "Cadeira" }] }),
      status: 200,
    });
    expect(preview?.missing).toEqual(["itens.0.preco"]);
  });

  test("a block with no token inside still needs a sample, and a broken block previews nothing", () => {
    // The block's output depends on how many items came back: without a body there is no answer.
    expect(
      templatePreviewFor({
        template: "{{#each itens}}x{{/each}}",
        sample: "",
        status: 200,
      }),
    ).toBeNull();
    // An unclosed block cannot be saved, and gets the reader's sentence under the box instead.
    expect(
      templatePreviewFor({
        template: "{{#each itens}}x",
        sample: SAMPLE,
        status: 200,
      }),
    ).toBeNull();
    expect(templateSaveProblem("{{#each itens}}x")).toContain("no {{/each}}");
  });
});

describe("insertEachBlock", () => {
  test("appends when there is no element, markers on lines of their own", () => {
    let value = "";
    insertEachBlock(null, "Total: {{total}}", "itens", (v) => {
      value = v;
    });
    expect(value).toBe("Total: {{total}}\n{{#each itens}}\n\n{{/each}}");
    // NOTE: what it inserts is not yet saveable, and the gate says what to write: a block with
    // nothing to repeat would render a full list as an empty body.
    expect(templateSaveProblem(value)).toContain("nothing to repeat");
    expect(
      templateSaveProblem(value.replace("\n\n", "\n- {{nome}}\n")),
    ).toBeNull();
  });

  test("a caret mid-line gets a line break on both sides, and lands between the markers", async () => {
    const el = document.createElement("textarea");
    el.value = "Total: {{total}} fim";
    document.body.appendChild(el);
    const caret = "Total: {{total}}".length;
    el.setSelectionRange(caret, caret);
    let value = "";
    insertEachBlock(el, el.value, "itens", (v) => {
      value = v;
      el.value = v;
    });
    expect(value).toBe("Total: {{total}}\n{{#each itens}}\n\n{{/each}}\n fim");
    // The caret is moved on the next frame, onto the empty line inside the block: reopening the
    // picker from there offers the items' fields.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(el.selectionStart).toBe(
      "Total: {{total}}\n{{#each itens}}\n".length,
    );
    el.remove();
  });

  test("a caret at a line start does not add a blank line before the block", () => {
    const el = document.createElement("textarea");
    el.value = "a\nb";
    el.setSelectionRange(2, 2);
    let value = "";
    insertEachBlock(el, el.value, "xs", (v) => {
      value = v;
    });
    expect(value).toBe("a\n{{#each xs}}\n\n{{/each}}\nb");
  });
});

test("the value picker offers every name the runtime renders into a template, and no other", () => {
  const offered = nativeVarItems(
    ((_k: string, fallback: string) => fallback) as unknown as Parameters<
      typeof nativeVarItems
    >[0],
  ).map((v) => v.name);
  expect(offered.sort()).toEqual(
    [...CONTEXT_VAR_NAMES, ...HTTP_TOOL_ONLY_VAR_NAMES].sort(),
  );
});

describe("the response limit", () => {
  test("empty is null, so the tool keeps the default; a typed value goes as a number", () => {
    expect(parseMaxResponseChars("")).toBeNull();
    expect(parseMaxResponseChars("  ")).toBeNull();
    expect(parseMaxResponseChars("12000")).toBe(12000);
    expect(Number.isNaN(parseMaxResponseChars("abc"))).toBe(true);
  });

  test("it loads into the form and saves back, and an empty field clears it", () => {
    const form = formFromTool(legacyTool({ maxResponseChars: 12000 }));
    expect(form.maxResponseChars).toBe("12000");
    expect(payloadOf(form)?.maxResponseChars).toBe(12000);
    expect(payloadOf({ ...form, maxResponseChars: "" })?.maxResponseChars).toBe(
      null,
    );
    expect(
      payloadOf(formFromTool(legacyTool({ maxResponseChars: null })))
        ?.maxResponseChars,
    ).toBeNull();
  });

  test("the preview clips by the form's limit, the way the runtime would", () => {
    const description = `${"d".repeat(8994)}FIM-9K`;
    const sample = JSON.stringify({ descricao: description, preco: "R$ 10" });
    const template = "Descrição: {{descricao}}\nPreço: {{preco}}";
    const raised = templatePreviewFor({
      template,
      sample,
      status: 200,
      maxResponseChars: 20000,
    });
    expect(raised?.text).toBe(`Descrição: ${description}\nPreço: R$ 10`);
    const asBefore = templatePreviewFor({ template, sample, status: 200 });
    expect(asBefore?.text).not.toContain("FIM-9K");
    expect(asBefore?.text).toContain(`${"d".repeat(2000)}…[truncated]`);
  });
});
