import { describe, expect, test } from "bun:test";
import {
  guidanceDraftHidden,
  guidanceToSave,
  type ToolGuidance,
} from "@/client/pages/agents/toolGuidance";

// On questions and rules the Tools tab does not draw the text a model reads, so its save writes that
// text as stored and an edit made before the switch is kept as a pending draft, not saved unseen.
const STORED: ToolGuidance = {
  handoffInstructions: "escalar só depois de duas tentativas",
  kanbanInstructions: "",
  customAttributeInstructions: "",
  labelInstructions: "uma etiqueta por assunto",
  updateKanbanTaskInstructions: "",
};
const EDITED: ToolGuidance = {
  ...STORED,
  labelInstructions: "editada antes de trocar de motor",
};

describe("the guidance a Tools save writes", () => {
  test("on questions and rules, the stored text, and the edit stays a draft", () => {
    expect(guidanceToSave(EDITED, STORED)).toEqual(STORED);
    expect(guidanceDraftHidden(EDITED, STORED)).toBe(true);
    expect(guidanceDraftHidden(STORED, STORED)).toBe(false);
  });

  test("on the language model, the form's text, with nothing hidden", () => {
    expect(guidanceToSave(EDITED, null)).toEqual(EDITED);
    expect(guidanceDraftHidden(EDITED, null)).toBe(false);
  });
});
