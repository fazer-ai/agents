import { describe, expect, test } from "bun:test";
import { contextNamesReferencedBy } from "@/client/pages/resources/ToolEditModal";
import { buildHttpTool } from "@/graph/tools/http";

// Round 2 of review, finding 4. The test dialog asks the operator for exactly the conversation
// placeholders the definition writes, and it used to ask by scanning the raw form text for
// `{{name}}`. A definition written the other supported way — OpenAPI-style `{contact_id}`, which
// `normalizeToolShapes` exists to accept — got no box, and the run then refused for a value nobody
// was offered a chance to supply.
//
// So the control here is not the list this function returns but its AGREEMENT with the runtime: the
// same definition is put through `buildHttpTool`, and whatever it demands is what the dialog has to
// have asked for.

const HOST = "8.8.8.8";

// What the tool actually needs, discovered by running it with the context it was given and seeing
// whether the request went out. `buildHttpTool` normalizes on the way in, exactly as production
// does for a row stored before that normalization existed.
async function runsWith(
  urlTemplate: string,
  context: Record<string, string>,
): Promise<boolean> {
  let went = false;
  const tool = buildHttpTool(
    {
      name: "t",
      method: "GET",
      urlTemplate,
      allowedHosts: [HOST],
      headers: {},
      inputSchema: {},
      expectedStatuses: [],
      credentialRef: null,
      credentialKind: null,
      credentialParamName: null,
      credentialBaseUrl: null,
      ackMessage: null,
      outputSchema: undefined,
    },
    {
      resolveCredential: async () => null,
      context,
      fetchImpl: (async () => {
        went = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    },
  );
  await tool.invoke({}).catch(() => {});
  return went;
}

describe("contextNamesReferencedBy", () => {
  test.each([
    ["{{contact_id}}", ["contact_id"]],
    // The form the whole finding is about.
    ["{contact_id}", ["contact_id"]],
    ["{ contact_id }", ["contact_id"]],
    // Not a context variable, so not a box: the operator does not supply these.
    ["{{secret}}", []],
    ["{{qty}}", []],
    ["{not_a_variable}", []],
  ])("%s -> %p", (segment, expected) => {
    expect(
      contextNamesReferencedBy({
        urlTemplate: `https://${HOST}/v1/${segment}`,
        query: {},
        headers: {},
        body: { mode: "kv", rows: [] },
        inputSchema: {},
      }),
    ).toEqual(expected);
  });

  test("finds them in query, headers, a raw body and a fixed field value", () => {
    expect(
      contextNamesReferencedBy({
        urlTemplate: `https://${HOST}/v1/x`,
        query: { c: "{conversation_id}" },
        headers: { "x-inbox": "{{inbox_id}}" },
        body: { mode: "raw", raw: '{"who": "{contact_name}"}' },
        // A legacy fixed field is a template too, and the set of form strings this replaced had no
        // entry for one.
        inputSchema: { who: { source: "fixed", value: "{contact_phone}" } },
      }).sort(),
    ).toEqual(["contact_name", "contact_phone", "conversation_id", "inbox_id"]);
  });

  test.each(["{{contact_id}}", "{contact_id}"])(
    "and %s is a value the runtime really demands",
    async (segment) => {
      const url = `https://${HOST}/v1/${segment}`;
      // Named by the scan…
      expect(contextNamesReferencedBy({ urlTemplate: url })).toEqual([
        "contact_id",
      ]);
      // …and refused by the runtime when it is not supplied, which is why naming it matters.
      expect(await runsWith(url, {})).toBe(false);
      expect(await runsWith(url, { contact_id: "42" })).toBe(true);
    },
  );
});
