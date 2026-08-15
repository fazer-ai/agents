import { describe, expect, test } from "bun:test";
import { approvalEditPatch } from "@/client/lib/approvalEdit";

// Decision table for what a review sends. `editApprovalItem` stamps EDITED on every call, so the
// question "did anything change" has to be answered before the request, not after.

const original = {
  proposedTitle: "Prazo de entrega",
  proposedContent: "O prazo é de 5 dias úteis.",
};

describe("approvalEditPatch", () => {
  test("an untouched draft sends nothing", () => {
    expect(
      approvalEditPatch(original, {
        title: "Prazo de entrega",
        content: "O prazo é de 5 dias úteis.",
      }),
    ).toBeNull();
  });

  test("a rewritten content sends only the content", () => {
    expect(
      approvalEditPatch(original, {
        title: "Prazo de entrega",
        content: "O prazo é de 5 dias úteis, contados da confirmação.",
      }),
    ).toEqual({
      content: "O prazo é de 5 dias úteis, contados da confirmação.",
    });
  });

  test("a renamed entry sends only the title", () => {
    expect(
      approvalEditPatch(original, {
        title: "Prazo de entrega padrão",
        content: "O prazo é de 5 dias úteis.",
      }),
    ).toEqual({ title: "Prazo de entrega padrão" });
  });

  test("both changed, both sent", () => {
    expect(
      approvalEditPatch(original, { title: "Prazos", content: "Cinco dias." }),
    ).toEqual({ title: "Prazos", content: "Cinco dias." });
  });

  // The textarea round-trips a trailing newline nobody typed; calling that a revision would stamp
  // EDITED on a card the reviewer only looked at.
  test("whitespace-only differences are not a revision", () => {
    expect(
      approvalEditPatch(original, {
        title: "  Prazo de entrega  ",
        content: "O prazo é de 5 dias úteis.\n",
      }),
    ).toBeNull();
  });

  test("an emptied content sends nothing", () => {
    expect(
      approvalEditPatch(original, {
        title: "Prazo de entrega",
        content: "   ",
      }),
    ).toBeNull();
  });

  // Even alongside a real content change: the endpoint writes the string it is given, and an empty
  // title would become the approved document's title (its fallback only catches null).
  test("a blank title is never sent", () => {
    expect(
      approvalEditPatch(original, { title: "  ", content: "Cinco dias." }),
    ).toEqual({ content: "Cinco dias." });
  });

  test("an entry that had no title can be given one", () => {
    expect(
      approvalEditPatch(
        { proposedTitle: null, proposedContent: "Cinco dias." },
        { title: "Prazos", content: "Cinco dias." },
      ),
    ).toEqual({ title: "Prazos" });
  });
});
