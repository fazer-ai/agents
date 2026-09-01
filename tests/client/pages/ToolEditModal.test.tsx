/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import {
  formFromTool,
  parseExpectedStatuses,
  payloadOf,
  type Tool,
  templatePreviewFor,
} from "@/client/pages/resources/ToolEditModal";
import { buildHttpTool } from "@/graph/tools/http";

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
        body: BODY,
        parsed: true,
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
        body: BODY,
        parsed: true,
        status: null,
      }),
    ).toEqual({
      projected: true,
      text: "Empresa: MAGAZINE LUIZA S/A",
      missing: [],
    });
  });

  test("nothing to preview without a template or without a parsed sample", () => {
    expect(
      templatePreviewFor({
        template: "   ",
        sample: SAMPLE,
        body: BODY,
        parsed: true,
        status: 200,
      }),
    ).toBeNull();
    expect(
      templatePreviewFor({
        template: TEMPLATE,
        sample: "not json",
        body: undefined,
        parsed: false,
        status: 200,
      }),
    ).toBeNull();
  });

  test("a non-2xx sample past the model's limit is previewed clipped, as the runtime clips it", async () => {
    const big = JSON.stringify({ message: "x".repeat(5000) });
    const preview = templatePreviewFor({
      template: TEMPLATE,
      sample: big,
      body: JSON.parse(big),
      parsed: true,
      status: 502,
    });
    expect(preview?.text).toContain("…[truncated]");
    // Not "clipped somehow": clipped to the same string, by the same rule.
    expect(preview?.text).toBe(await runtimeText(502, big));
  });
});
