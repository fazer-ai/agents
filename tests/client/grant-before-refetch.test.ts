import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// A just-created tool is granted to the agent being edited, and the grant is computed from the
// `nonRag` of the render that created the callback. So the auto-grant has to run BEFORE the catalog
// refetch is awaited: after the await, anything the operator changed in the meantime is overwritten
// by that older list — the newer grant simply disappears, with the save's own toast on screen.
//
// A fence over ORDER, because the alternative is a test that has to lose a race on purpose. The
// integration callback is the exception and stays as it is: its grant carries the instance's tool
// names, so it genuinely needs the refreshed catalog, and it defers through `pendingIntegrationId`
// with an effect that reads the CURRENT grants.
const SRC = readFileSync(
  "src/client/pages/agents/ToolGrantsEditor.tsx",
  "utf8",
);

describe("a just-created component is granted before the catalog is awaited", () => {
  for (const [callback, select] of [
    ["onToolSaved", "selectHttp"],
    ["onCodeToolSaved", "selectCode"],
    ["onMcpSaved", "selectMcp"],
  ] as const) {
    test(`${callback} grants with the id in hand, then refreshes`, () => {
      const start = SRC.indexOf(`async function ${callback}(`);
      expect(start).toBeGreaterThan(0);
      const body = SRC.slice(start, SRC.indexOf("\n  }\n", start));
      const grant = body.indexOf(`${select}(saved.id)`);
      const refetch = body.indexOf("await onCatalogChange()");
      expect(grant).toBeGreaterThan(0);
      expect(refetch).toBeGreaterThan(0);
      expect(grant < refetch).toBe(true);
    });
  }
});

// The other half of the same problem: WHICH grants the auto-grant adds to. The callback is held by
// a dialog, so it carries the closure of the render that opened it — and a save answering after the
// operator changed another grant would emit that older list, silently reverting the change. So the
// selectors read a ref that is rewritten on every render, never the render's own `nonRag`.
describe("the auto-grants add to the grants as they stand now", () => {
  test("each selector reads the ref, and adds through it", () => {
    for (const select of ["selectHttp", "selectCode", "selectMcp"]) {
      const start = SRC.indexOf(`function ${select}(id: string) {`);
      expect([select, start > 0]).toEqual([select, true]);
      const body = SRC.slice(start, SRC.indexOf("\n  }\n", start));
      expect([select, body.includes("hasGrant(")]).toEqual([select, true]);
      expect([select, body.includes("addGrant(")]).toEqual([select, true]);
      // The render's own list is exactly what must NOT be read here.
      expect([select, body.includes("nonRag")]).toEqual([select, false]);
    }
    // And the ref is refreshed on every render, or it is a snapshot with extra steps.
    expect(SRC.includes("grantsRef.current = grants;")).toBe(true);
  });
});
