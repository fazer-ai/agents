import { describe, expect, test } from "bun:test";
import { describeLabelWrite } from "@/graph/tools/label-writes";

// Issue #635, review round 2. `detail` is allowlisted ids, counts and enums (docs/logs.md), and a
// label title is not one: `set_labels` takes the model's array and Chatwoot CREATES a title it does
// not have, so one cache refresh later the account's own list contains the invented string and no
// filter against that list can tell it from an operator's label. The entry therefore counts.

describe("describeLabelWrite", () => {
  test("counts what moved and what the scope has afterwards", () => {
    expect(
      describeLabelWrite(
        "conversation",
        ["cancelamento"],
        ["compra-de-ingresso"],
        ["cancelamento", "agente-off"],
      ),
    ).toEqual({ scope: "conversation", added: 1, removed: 1, after: 2 });
  });

  test("no title reaches the entry, whatever the model called the label", () => {
    const w = describeLabelWrite(
      "contact",
      ["cliente Zebrafina Quixotesca", "zebrafina@example.com"],
      ["pedido-99887766"],
      ["cliente Zebrafina Quixotesca"],
    );
    expect(w).toEqual({ scope: "contact", added: 2, removed: 1, after: 1 });
    expect(JSON.stringify(w).toLowerCase()).not.toContain("zebrafina");
    expect(JSON.stringify(w)).not.toContain("99887766");
  });

  test("the scope is carried, because three of them can be written in one turn", () => {
    expect(describeLabelWrite("task", [], ["x"], []).scope).toBe("task");
  });
});
