import { expect, test } from "bun:test";

// Every warning the import can emit has a sentence in the editor. The codes are string literals on
// both sides and nothing ties them together: a code added to transfer.ts without its case (e.g.
// `httpToolRenamed`) would reach the operator as the switch's fallback, and a rename a prompt may
// still depend on must not be quiet.
test("every import warning code emitted by transfer.ts is rendered by the editor", async () => {
  const transfer = await Bun.file("src/modules/agents/transfer.ts").text();
  const editor = await Bun.file(
    "src/client/pages/agents/AgentEditorPage.tsx",
  ).text();
  const emitted = new Set(
    [...transfer.matchAll(/\bcode: "([A-Za-z]+)"/g)].map((m) => m[1] as string),
  );
  expect(emitted.size).toBeGreaterThan(10);
  const rendered = new Set(
    [...editor.matchAll(/\bcase "([A-Za-z]+)":/g)].map((m) => m[1] as string),
  );
  expect([...emitted].filter((c) => !rendered.has(c)).sort()).toEqual([]);
});
