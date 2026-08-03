/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import {
  formFromTool,
  type Tool,
} from "@/client/pages/resources/ToolEditModal";

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
    riskTier: "medium",
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
