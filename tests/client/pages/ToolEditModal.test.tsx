/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import {
  formFromTool,
  outputSchemaForm,
  parseExpectedStatuses,
  payloadOf,
  type Tool,
  templatePreviewFor,
  templateSaveProblem,
} from "@/client/pages/resources/ToolEditModal";
import { buildHttpTool } from "@/graph/tools/http";
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

// Issue #59: the operator types a list; the server normalizes it (dedupe, sort, drop 2xx and
// out-of-range). The field is permissive on purpose — a stray separator is not worth failing a save.
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

// #456. The response template travels through the form as plain markdown; the {mode, template}
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

// Round 3 of review, finding 4. The preview is labelled "exactly what the agent would receive", and
// the runtime projects the template on 2xx ALONE — so a sample captured from a status outside that
// range had the preview promising something the very same test run had just reported otherwise.
//
// The control is agreement with `buildHttpTool`, not with this file's reading of it: each case runs
// the same definition through the runtime and compares.
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
      expect(preview?.projected).toBe(status >= 200 && status < 300);
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
      projected: true,
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

// Round 4 of review, finding 3. `outputSchema` accepted anything before this feature validated it
// (MCP `tool_create` passed it through), so a row can hold `{mode:"template", template:42}`: a
// declaration the reader refuses. Keeping it verbatim meant the editor showed an empty box, resent
// the broken object on every save, and the service refinement — new in this same change — rejected
// it. The operator could then edit nothing about that tool, and nothing said why.
describe("outputSchemaForm", () => {
  test("a broken template declaration is dropped, with the reader's own reason", () => {
    const got = outputSchemaForm({ mode: "template", template: 42 });
    expect(got.outputTemplate).toBe("");
    // The resend is what locked the tool.
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

// Round 5 of review. Both findings are the same defect twice: the preview restated the runtime's
// rules instead of asking it, so every rule the runtime learned in rounds 3 and 4 left the preview
// behind. It now calls `projectToolResponse`, and these are the three cases that were wrong.
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
    // Two 2,000-character fields and a separator: the substitutions, not the template, are what
    // overrun. The runtime clips the PROJECTED body too — that is round 1's surviving mutant — and
    // the preview was showing the whole thing under "exactly what the agent would receive".
    const body = JSON.stringify({ a: "x".repeat(2000), b: "y".repeat(2000) });
    const template = "{{a}}\n---\n{{b}}";
    const preview = templatePreviewFor({ template, sample: body, status: 200 });
    expect(preview?.projected).toBe(true);
    expect(preview?.text).toContain("…[truncated]");
    expect(preview?.text).toBe(await runtimeText(200, body, template));
  });

  test("a token-less template is previewed for a 204 with no body at all", async () => {
    // The sample field is EMPTY here, which used to mean "nothing to preview". The runtime hands
    // the model the operator's own text, so an empty box was the wrong answer.
    const preview = templatePreviewFor({
      template: "Done. The booking is confirmed.",
      sample: "",
      status: 204,
    });
    expect(preview?.projected).toBe(true);
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
    // Previously null: no preview at all, for a call that succeeds and reaches the model.
    expect(preview?.projected).toBe(false);
    expect(preview?.text).toBe(await runtimeText(200, "not json at all"));
  });
});

// Round 6 of review, findings 1 and 2. Two more ways the console answered a question the server
// answers differently — and both are the same shape as round 5's: a rule restated instead of asked.
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
    expect(preview?.projected).toBe(false);
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

// Round 6 of review, finding 2. The Save button was gated on the two problems this screen can phrase
// well — an unusable token, a stray brace — while the service refines with the WHOLE reader, which
// also refuses a template past the character limit and one carrying a NUL or a lone surrogate. For
// those, Save stayed enabled on a payload the server was always going to reject.
//
// So the test is not a list of shapes this file thinks are bad: it is the agreement itself, each
// shape put through the console's gate and the service's schema and required to get the same answer.
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
