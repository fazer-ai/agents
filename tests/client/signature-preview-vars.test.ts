import { describe, expect, test } from "bun:test";
import {
  SIGNATURE_PREVIEW_VARS,
  signaturePreviewParts,
} from "@/client/pages/agents/BehaviorTab";
import {
  PROMPT_CONTEXT_VARS,
  PROMPT_SCHEDULE_VARS_DISPLAY,
  type PromptRenderOpts,
} from "@/graph/prompt";
import { SIGNATURE_DEFAULTS } from "@/modules/signature/service";

// EVERY VARIABLE THE SIGNATURE FIELD ACCEPTS RESOLVES IN ITS PREVIEW.
//
// Three review rounds of #599 reported this one name at a time, which is what a fence is for. The
// preview renders an unresolved placeholder as the operator's own literal — the right behaviour for
// a TYPO, and a lie for a name the field supports, because the operator reads "this does not work"
// and stops using it. The three reported were `{{email_contato}}`, `{{telefone_contato}}` and
// `{{canal}}` (a hand-written example map that had fallen behind the chips) and then
// `{{horario_atendimento}}` (the map was passed without the render options a schedule name needs).
//
// Asked over the LISTS the editor itself offers, so a variable added to the prompt is covered here
// without anyone remembering to add it.
const t = (_k: string, d: string) => d;

const SOURCE = await Bun.file("src/client/pages/agents/BehaviorTab.tsx").text();

const OPTS: PromptRenderOpts = {
  availability: {
    schedule: {
      timezone: "America/Sao_Paulo",
      windows: [
        { day: 1, start: "09:00", end: "18:00" },
        { day: 2, start: "09:00", end: "18:00" },
      ],
      exceptions: [],
    },
  },
  // A Monday inside the window above, so `{{esta_aberto}}` and `{{proximo_atendimento}}` have a real
  // answer instead of resolving against whatever day the suite runs on.
  now: new Date("2026-09-14T13:00:00Z"),
};

function preview(text: string): string {
  return signaturePreviewParts(
    { ...SIGNATURE_DEFAULTS, text },
    t,
    SIGNATURE_PREVIEW_VARS,
    OPTS,
  ).join("\n");
}

describe("the signature preview answers every variable the field offers", () => {
  for (const name of [
    ...PROMPT_CONTEXT_VARS,
    ...PROMPT_SCHEDULE_VARS_DISPLAY,
  ]) {
    test(`{{${name}}} does not come back literal`, () => {
      expect(preview(`— {{${name}}}`)).not.toContain(`{{${name}}}`);
    });
  }

  // POSITIVE CONTROL: the assertion must be able to FAIL, or every case above passes because the
  // preview returned something unrelated. A name the field does not support stays literal, which is
  // the rule that makes a typo visible.
  test("an unsupported name still comes back literal", () => {
    expect(preview("— {{nao_existe}}")).toContain("{{nao_existe}}");
  });

  test("the example map itself carries every context name", () => {
    const missing = PROMPT_CONTEXT_VARS.filter(
      (v) => !(v in SIGNATURE_PREVIEW_VARS),
    );
    expect(missing).toEqual([]);
  });
});

// The cases above prove the FUNCTION honours its options. What the review found was the CALL SITE
// not passing them, which no amount of calling the function directly can catch — so this reads the
// tab's own source, the way the repo's other placement fences do.
describe("the tab passes the render options to its preview", () => {
  test("the preview call forwards an options argument", () => {
    const at = SOURCE.indexOf("{signaturePreviewParts(");
    expect(at).toBeGreaterThan(-1);
    const call = SOURCE.slice(at, SOURCE.indexOf(").map(", at));
    // Four arguments: the state, `t`, the example variables, and the options.
    expect(call).toContain("SIGNATURE_PREVIEW_VARS");
    expect(call).toContain("signaturePreviewOpts");
  });

  test("those options carry an availability, which is what a schedule name needs", () => {
    const at = SOURCE.indexOf("const signaturePreviewOpts");
    expect(at).toBeGreaterThan(-1);
    expect(SOURCE.slice(at, at + 400)).toContain("availability");
  });
});
