import { describe, expect, test } from "bun:test";
import { describeLabelWrite } from "@/graph/tools/label-writes";

// Issue #635. `detail` is allowlisted ids, counts and enums (docs/logs.md), and a label title is only
// a closed vocabulary while the ACCOUNT'S list names it: `set_labels` takes the model's array, so a
// title can be a string the model wrote about a customer. This function is the fence.

describe("describeLabelWrite", () => {
  const vocab = ["compra-de-ingresso", "cancelamento", "duvidas-evento"];

  test("names the titles the account's list has", () => {
    expect(
      describeLabelWrite(
        "conversation",
        ["cancelamento"],
        ["compra-de-ingresso"],
        ["cancelamento", "agente-off"],
        vocab,
      ),
    ).toEqual({
      scope: "conversation",
      added: ["cancelamento"],
      removed: ["compra-de-ingresso"],
      after: 2,
      unnamed: 0,
    });
  });

  test("counts what the list does not have instead of naming it", () => {
    const w = describeLabelWrite(
      "contact",
      ["cancelamento", "cliente Zebrafina Quixotesca"],
      ["pedido-99887766"],
      ["cancelamento"],
      vocab,
    );
    expect(w.added).toEqual(["cancelamento"]);
    expect(w.removed).toEqual([]);
    expect(w.unnamed).toBe(2);
    expect(JSON.stringify(w)).not.toContain("Zebrafina");
  });

  test("with no vocabulary read, nothing is named at all", () => {
    expect(
      describeLabelWrite(
        "task",
        ["cancelamento"],
        ["compra-de-ingresso"],
        ["cancelamento"],
        undefined,
      ),
    ).toEqual({
      scope: "task",
      added: [],
      removed: [],
      after: 1,
      unnamed: 2,
    });
  });

  // `detail` bounds each string and nothing bounds an array's length, so the row needs this cap.
  test("the named lists are capped", () => {
    const many = Array.from({ length: 40 }, (_, i) => `etiqueta-${i}`);
    const w = describeLabelWrite("conversation", many, [], many, many);
    expect(w.added.length).toBe(20);
    expect(w.unnamed).toBe(20);
    expect(w.after).toBe(40);
  });
});
