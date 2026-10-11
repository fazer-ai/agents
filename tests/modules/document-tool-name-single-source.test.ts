import { expect, test } from "bun:test";
import { documentToolName } from "@/modules/documents/slug";

// ONE PLACE SPELLS THE TOOL NAME. `send_<slug>` is what the model is offered, what the grants editor
// shows the operator, and what the template modal previews while they type a name. That no other
// module builds it by hand is biome-plugins/no-document-tool-name-outside-slug.grit.

test("and the one module produces what everything else asks it for", () => {
  expect(documentToolName("orcamento")).toBe("send_orcamento");
});
