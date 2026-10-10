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
  transferWithSummary: true,
  resolveConversation: { assignLabels: ["vip"] },
  crossInboxCase: {
    targetInboxId: "",
    targetInstanceId: "",
    originLabel: "",
    caseLabels: [],
    caseAttributeKey: "",
    mergeContacts: false,
    resolveOrigin: false,
    subjectTemplate: "",
    openingTemplate: "",
    noteTemplate: "",
    carryMode: "off",
    carryFileTypes: ["image", "file"],
    carryMaxFiles: 10,
  },
  sendImage: { allowedHosts: "" },
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

// The summary before a handoff is a model's too: switched off before the engine changed, it stays a
// draft rather than being saved unseen.
test("the summary switch is a hidden draft on questions and rules", () => {
  const off = { ...STORED, transferWithSummary: false };
  expect(guidanceToSave(off, STORED).transferWithSummary).toBe(true);
  expect(guidanceDraftHidden(off, STORED)).toBe(true);
});
