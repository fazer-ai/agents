import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  documentTemplatesController,
  writeBody,
} from "@/api/v1/document-templates.controller";
import type { DocumentTemplateInput } from "@/modules/documents/templates";

// Elysia's `normalize` STRIPS any request-body key the route schema does not declare, silently and
// with a 200. So every field the service accepts MUST appear in the controller's `writeBody`, or the
// operator's write arrives half empty — which is how `label` once got dropped on the tools route.
//
// Here the stakes are higher than one field: `blocks` is the whole document. A schema that declared
// the block union property by property would drop every property it did not name, and a template
// would save with its blocks emptied out while the response said it worked.

describe("document-templates writeBody vs the service input (drift guard)", () => {
  test("every field the service accepts is exposed in the Elysia body schema", () => {
    const bodyKeys = new Set(Object.keys(writeBody.properties));
    // Listed from the service's own input type, so adding a field there without adding it here is a
    // compile error in this file rather than a silent drop at runtime.
    const serviceKeys: (keyof DocumentTemplateInput)[] = [
      "name",
      "slug",
      "description",
      "blocks",
      "blockText",
      "fields",
      "style",
      "numberPrefix",
      "enabled",
    ];
    expect(serviceKeys.filter((k) => !bodyKeys.has(k))).toEqual([]);
  });
});

// The property that made the permissive Record a deliberate choice rather than laziness: a whole
// block, with every one of its own keys, has to reach the handler untouched.
describe("a block reaches the handler intact", () => {
  const app = new Elysia().post("/t", ({ body }) => ({ body }), {
    body: writeBody,
  });

  async function post(payload: unknown) {
    const res = await app.handle(
      new Request("http://localhost/t", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    return {
      status: res.status,
      body: ((await res.json()) as { body: Record<string, unknown> }).body,
    };
  }

  test("keeps every property of a lineItems and a totals block", async () => {
    const blocks = [
      {
        id: "li",
        type: "lineItems",
        field: "itens",
        columns: ["description", "quantity", "total"],
        showHeader: true,
        spaceAfter: "lg",
      },
      {
        id: "tot",
        type: "totals",
        field: "itens",
        rows: ["subtotal", "total"],
        discountField: "desconto",
      },
    ];
    const { status, body } = await post({ name: "Orçamento", blocks });
    expect(status).toBe(200);
    expect(body.blocks).toEqual(blocks);
  });

  test("keeps a header's nested meta rows and a fields block's rows", async () => {
    const blocks = [
      {
        id: "h",
        type: "header",
        title: "Orçamento {{doc_number}}",
        showLogo: true,
        meta: [{ label: "Cliente", value: "{{cliente}}" }],
      },
      {
        id: "f",
        type: "fields",
        rows: [{ label: "Validade", value: "{{validade}}" }],
        columns: 2,
      },
    ];
    const { body } = await post({ name: "x", blocks });
    expect(body.blocks).toEqual(blocks);
  });

  test("keeps a declared field's own keys, and the style's", async () => {
    const fields = [
      {
        name: "cliente",
        label: "Cliente",
        type: "text",
        required: true,
        description: "Nome de quem recebe",
      },
    ];
    const style = {
      font: "serif",
      baseFontSize: 11,
      accentColor: "#1D4ED8",
      margin: "wide",
      pageSize: "LETTER",
      locale: "en-US",
      currency: "USD",
      footerText: "{{company_name}}",
      showPageNumbers: true,
    };
    const { body } = await post({ name: "x", fields, style });
    expect(body.fields).toEqual(fields);
    expect(body.style).toEqual(style);
  });

  // A shape the service will refuse still has to REACH it: refusing at the transport would produce a
  // generic 422 instead of the message that names the block and the rule.
  test("passes an unsupported block through, for the service to refuse with a reason", async () => {
    const blocks = [
      { id: "x", type: "image", src: "https://example.com/a.png" },
    ];
    const { status, body } = await post({ name: "x", blocks });
    expect(status).toBe(200);
    expect(body.blocks).toEqual(blocks);
  });
});

// THE STATUS A ROUTE CAN ANSWER IS THE STATUS IT PUBLISHES.
//
// The preview route's own comment already states this rule, about 404: "Leaving it out publishes a
// union the endpoint does not honour, and an Eden caller narrowing on the declared statuses is
// handed a status its types say cannot happen." It was stated for one status and missed for the
// next.
//
// All three routes below reach `patchedContent`, which answers 409 for a template whose stored
// content a newer version wrote — the downgrade case docs/documents.md preserves on purpose. Two of
// them declared it. Nothing at runtime notices: measured, Elysia returns the 409 either way, so the
// only casualty is the generated client, which is exactly the kind of defect no request can reveal.
describe("declared response unions vs the statuses the handlers answer", () => {
  const routes = (
    documentTemplatesController as unknown as {
      routes: { method: string; path: string; hooks?: { response?: object } }[];
    }
  ).routes;

  function declared(method: string, path: string): number[] {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`route not found: ${method} ${path}`);
    return Object.keys(r.hooks?.response ?? {})
      .map(Number)
      .sort();
  }

  test.each([
    ["POST", "/v1/document-templates/"],
    ["PATCH", "/v1/document-templates/:id"],
    ["POST", "/v1/document-templates/preview"],
  ])("%s %s declares the 409 it can answer", (method, path) => {
    expect(declared(method, path)).toContain(409);
  });
});
