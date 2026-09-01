import { expect, test } from "bun:test";

// #464 was ONE defect in three files and a near-miss in five more, and reading any single one of
// them told you nothing: `clearTimeout` in the `finally` of a fetch is right when the body is read
// inside the try and wrong when it is read on the next line. The difference is two lines apart and
// invisible in review, which is why the property is scanned here instead of remembered.
const THROUGH_THE_BOUND = [
  "src/graph/tools/http.ts",
  "src/modules/vault/mcp-oauth.ts",
  "src/modules/vault/google-oauth.ts",
  "src/modules/integrations/google-calendar.service.ts",
  "src/modules/integrations/google-drive.service.ts",
  "src/modules/integrations/toolpacks/asaas.ts",
  "src/modules/integrations/toolpacks/google-calendar.ts",
  "src/modules/integrations/toolpacks/google-drive.ts",
];

// Comments are stripped before matching, and that is not a detail: the files below EXPLAIN the
// shape they no longer use, so a fence read against the prose would fail on a file that is right
// and pass on one whose only mention of `.json()` sits inside a comment.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test.each(THROUGH_THE_BOUND)("%s reads its body under the bound", async (f) => {
  const src = code(await Bun.file(f).text());
  expect(src).toMatch(/fetchBounded(?:Bytes)?\(/);
  // No abort timer of its own: there is one place that arms one, and it is the place that also
  // does the reading.
  expect(src).not.toMatch(/clearTimeout\(/);
  expect(src).not.toMatch(/new AbortController\(\)/);
  // And no read the bound cannot cover. `fetchBounded` hands back text, never an unread Response,
  // so a second read is not something a caller here can reach for by accident.
  expect(src).not.toMatch(/\bres\.(?:text|json|arrayBuffer|blob)\(/);
});

test("the one file that reaches the same property another way still does", async () => {
  // Named so it is not "fixed" into the list above, and so the list is not read as "everything
  // else is unbounded". `AbortSignal.timeout()` stays armed through the body read — there is no
  // timer to clear, which is the whole reason it cannot go wrong the way the eight above did.
  const src = code(await Bun.file("src/modules/chatwoot/client.ts").text());
  expect(src).toMatch(/signal:\s*AbortSignal\.timeout\(/);
  expect(src).not.toMatch(/clearTimeout\(/);
});
