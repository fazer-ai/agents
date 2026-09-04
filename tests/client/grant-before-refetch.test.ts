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
