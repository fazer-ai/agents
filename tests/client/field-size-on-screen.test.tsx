/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { SPOKEN_NOTICE_DEFAULT } from "@/modules/tts/settings-shared";
import { DEFAULT_EXTRACTION_PROMPT } from "@/modules/vision/prompt-default";
import {
  NATIVE_CATALOG,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// Every field whose text reaches a model says, under it, how big it is and which call it goes to: the
// editor as the operator opens it, with the fields already filled.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function goTo(tab: string) {
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  await screen.findByRole("tab", { name: tab, selected: true });
}

// The size lines on screen, as "<field text length> → <where>", one per line drawn.
function sizeLines(): string[] {
  return [...document.querySelectorAll("p")]
    .map((p) => p.textContent ?? "")
    .filter((s) => / characters, /.test(s))
    .map((s) => s.replace(/^~[\d,]+ tokens · ([\d,]+) characters, /, "$1 → "))
    .sort();
}

const SETTINGS = {
  followUp: {
    enabled: true,
    steps: [
      {
        delayValue: 60,
        delayUnit: "minutes",
        instructions: "Pergunte se ainda há interesse.",
      },
    ],
  },
  vision: { enabled: true, extractionPrompt: "Descreva a imagem." },
  tts: {
    mode: "mirror",
    spokenNotice: true,
    spokenNoticeText: "",
    textChoice: true,
    textChoiceNote: "Use para preços.",
  },
  handoff: { instructions: "Só transfira depois de duas tentativas." },
  toolGuidance: {
    set_labels: "Uma etiqueta por conversa.",
    set_custom_attribute: "Guarde o orçamento.",
  },
  channelRedirect: {
    enabled: true,
    chatFollowupEnabled: true,
    chatFollowupInstructions: "Pergunte se precisa de ajuda.",
  },
  guardrails: {
    enabled: true,
    customPolicy: "Seja breve.",
    competitors: ["Acme", " Beta "],
    output: {
      enabled: true,
      checks: { competitorMentions: true },
      action: "generated",
      generationPrompt: "Reescreva com calma.",
    },
  },
};

describe("field sizes on the agent editor", () => {
  test("Guardrails: the policy, the competitors and the generation guidance", async () => {
    const stub = stubEditorApi({ settings: SETTINGS });
    await renderEditor(stub, "behavior");
    await goTo("Guardrails");
    expect(sizeLines()).toEqual([
      // The competitors as the check receives them: trimmed, joined by commas.
      "10 → sent on each guardrail check",
      "11 → sent on each guardrail check",
      "20 → sent on each guardrail check",
    ]);
  });

  test("the line follows what is typed", async () => {
    const stub = stubEditorApi({ settings: SETTINGS });
    await renderEditor(stub, "behavior");
    await goTo("Guardrails");
    fireEvent.change(screen.getByRole("textbox", { name: "Custom policy" }), {
      target: { value: "Seja breve e cordial." },
    });
    expect(sizeLines()).toContain("21 → sent on each guardrail check");
    // Past the cap, the check receives the first 2,000 characters, and the line says so.
    fireEvent.change(screen.getByRole("textbox", { name: "Custom policy" }), {
      target: { value: "x".repeat(2100) },
    });
    expect(sizeLines()).toContain("2,000 → sent on each guardrail check");
    // A blank line and the spaces around a name, as typed, are not sent.
    fireEvent.change(screen.getByRole("textbox", { name: "Competitors" }), {
      target: { value: "Acme\n\n Gama " },
    });
    expect(sizeLines()).toContain("10 → sent on each guardrail check");
    expect(sizeLines()).not.toContain("15 → sent on each guardrail check");
  });

  test("Tools: each note says it is part of its tool's description", async () => {
    const stub = stubEditorApi(
      { settings: SETTINGS },
      { catalog: NATIVE_CATALOG },
    );
    await renderEditor(stub, "tools");
    for (const b of screen.queryAllByRole("button", { name: "Settings" }))
      fireEvent.click(b);
    expect(sizeLines()).toEqual([
      // The notes left empty still show their line, at zero.
      "0 → part of this tool's description (counted in its tokens per call)",
      "0 → part of this tool's description (counted in its tokens per call)",
      "19 → part of this tool's description (counted in its tokens per call)",
      "26 → part of this tool's description (counted in its tokens per call)",
      "39 → part of this tool's description (counted in its tokens per call)",
    ]);
  });

  test("Behavior: the follow-up step, the vision prompt, the spoken notice as sent and the text-choice note", async () => {
    const stub = stubEditorApi({ settings: SETTINGS });
    await renderEditor(stub, "behavior");
    expect(sizeLines()).toEqual(
      [
        "16 → part of this tool's description (counted in its tokens per call)",
        "18 → sent on each image or PDF read",
        "31 → sent on each call of this follow-up step",
        // Left empty, the notice sent is the default, and that is what is counted.
        `${SPOKEN_NOTICE_DEFAULT.length.toLocaleString("en")} → sent on each turn answered by audio`,
      ].sort(),
    );
  });

  test("Channel redirect: the chat follow-up's instructions", async () => {
    const stub = stubEditorApi({ settings: SETTINGS });
    await renderEditor(stub, "channelRedirect");
    expect(sizeLines()).toEqual(["29 → sent on the chat follow-up's call"]);
  });

  test("Behavior: the text-choice switch carries reply_as_text's number from the floor", async () => {
    const stub = stubEditorApi({ settings: SETTINGS });
    stub.override = (method, path) =>
      method === "POST" && path.endsWith("/call-floor")
        ? new Response(
            JSON.stringify({
              floor: {
                engine: "llm",
                instructions: 10,
                instructionsAdded: 0,
                instructionsAddedBy: { grounding: 0, mcp: 0 },
                tools: [
                  {
                    name: "reply_as_text",
                    category: "external",
                    estimatedTokens: 95,
                  },
                ],
                total: 105,
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          )
        : undefined;
    await renderEditor(stub, "behavior");
    expect(await screen.findByText("~95 tokens per call")).toBeTruthy();
  });

  test("Behavior: a cleared vision prompt counts the default the reader sends", async () => {
    const stub = stubEditorApi({
      settings: {
        ...SETTINGS,
        vision: { enabled: true, extractionPrompt: "x" },
      },
    });
    await renderEditor(stub, "behavior");
    const box = screen
      .getAllByRole("textbox")
      .find((el) => (el as HTMLTextAreaElement).value === "x");
    if (!box) throw new Error("no vision prompt box");
    fireEvent.change(box, { target: { value: "   " } });
    expect(sizeLines()).toContain(
      `${DEFAULT_EXTRACTION_PROMPT.length.toLocaleString("en")} → sent on each image or PDF read`,
    );
  });
});
