/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import {
  formFromTool,
  parseExpectedStatuses,
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
