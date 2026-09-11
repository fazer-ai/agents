import { describe, expect, test } from "bun:test";
import {
  SIGNATURE_PREVIEW_VARS,
  signaturePreviewParts,
} from "@/client/pages/agents/BehaviorTab";
import {
  PROMPT_CONTEXT_VARS,
  PROMPT_PREVIEW_CONTACT,
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
const PROMPT_SOURCE = await Bun.file(
  "src/client/pages/agents/PromptPanel.tsx",
).text();

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

// ONE EXAMPLE PERSON FOR THE WHOLE EDITOR, AND NOBODY REAL IN IT.
//
// The signature preview shipped with a second sample contact, a second sample company and a second
// sample agent, invented beside the ones the prompt editor two clicks away already used — and the
// company and agent were a live customer of one deployment, in a product that ships to every
// deployment. Both are the same defect seen from two sides: sample data written where it is needed
// rather than read from where it already exists. The fence is the shared constant, because a
// hand-written literal is what drifts.
describe("the editor's previews speak to one example person", () => {
  test("both preview call sites read the shared example contact", () => {
    expect(SOURCE).toContain("PROMPT_PREVIEW_CONTACT");
    expect(PROMPT_SOURCE).toContain("PROMPT_PREVIEW_CONTACT");
  });

  test("the signature preview resolves the shared contact, not one of its own", () => {
    expect(preview("{{nome_contato}}")).toContain(
      PROMPT_PREVIEW_CONTACT.contactName,
    );
    expect(preview("{{email_contato}}")).toContain(
      PROMPT_PREVIEW_CONTACT.contactEmail,
    );
  });

  // A sample contact hard-coded next to the call site is how the two previews drifted apart the
  // first time. Asked of both files, so neither editor can grow a private one back.
  test("neither editor hard-codes a sample contact beside its preview", () => {
    // Booleans, not the file: a failed `expect(src).not.toContain(...)` prints the whole tab.
    const files: Array<[string, string]> = [
      ["BehaviorTab.tsx", SOURCE],
      ["PromptPanel.tsx", PROMPT_SOURCE],
    ];
    const offenders = files.flatMap(([name, src]) => [
      ...(src.includes("@exemplo.com") ? [`${name}: sample e-mail`] : []),
      ...(/contactName: "/.test(src) ? [`${name}: sample name`] : []),
    ]);
    expect(offenders).toEqual([]);
  });
});
