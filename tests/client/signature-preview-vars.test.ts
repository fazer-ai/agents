import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  signaturePreviewParts,
  signaturePreviewVars,
} from "@/client/pages/agents/BehaviorTab";
import {
  PROMPT_CONTEXT_VARS,
  PROMPT_PREVIEW_AGENT,
  PROMPT_PREVIEW_COMPANY,
  PROMPT_PREVIEW_CONTACT,
  PROMPT_SCHEDULE_VARS_DISPLAY,
  type PromptRenderOpts,
} from "@/graph/prompt";
import { SIGNATURE_DEFAULTS } from "@/modules/signature/service";
import {
  type EditorStub,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// EVERY VARIABLE THE SIGNATURE FIELD ACCEPTS RESOLVES IN ITS PREVIEW.
//
// The preview renders an unresolved placeholder as the operator's own literal: right for a TYPO, and
// a lie for a name the field supports, because the operator reads "this does not work" and stops
// using it. Schedule names also need the render options, not only the example map. Asked over the
// LISTS the editor itself offers, so a variable added to the prompt is covered without anyone
// remembering to add it.
const t = (_k: string, d: string) => d;

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

// No names given: the stand-ins, which is the editor with an agent still being named.
const FALLBACK_VARS = signaturePreviewVars();

function preview(text: string, vars = FALLBACK_VARS): string {
  return signaturePreviewParts({ ...SIGNATURE_DEFAULTS, text }, t, vars, OPTS)
    .flat()
    .join("\n");
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
    const missing = PROMPT_CONTEXT_VARS.filter((v) => !(v in FALLBACK_VARS));
    expect(missing).toEqual([]);
  });
});

// The cases above prove the FUNCTION honours its options; only the CALL SITE can fail to pass them,
// so these render the editor's Behavior tab and read its preview: the agent's schedule, its live
// names and its split switch have to reach the bubbles.
const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const SCHEDULE = {
  id: "5",
  name: "Comercial",
  timezone: "America/Sao_Paulo",
  windows: [{ day: 1, start: "09:00", end: "18:00" }],
  exceptions: [],
};

async function behaviorPreview(
  text: string,
  over: { split?: boolean; name?: string } = {},
): Promise<EditorStub> {
  const stub = stubEditorApi({
    name: over.name ?? "Recepção",
    settings: {
      signature: {
        enabled: true,
        text,
        position: "top",
        frequency: "all",
        separator: "blank",
      },
      split: { enabled: over.split ?? false },
    },
  });
  stub.agent.businessHoursId = SCHEDULE.id;
  stub.override = (method, path) =>
    method === "GET" && path === "/api/v1/business-hours"
      ? new Response(JSON.stringify({ businessHours: [SCHEDULE] }), {
          headers: { "Content-Type": "application/json" },
        })
      : undefined;
  await renderEditor(stub, "behavior");
  await act(async () => {});
  return stub;
}

// The preview's own text: everything the signature section draws after its "Preview" heading.
function shownPreview(): string {
  const all = document.getElementById("signature")?.textContent ?? "";
  return all.slice(all.lastIndexOf("Preview") + "Preview".length);
}

describe("the tab passes the render options to its preview", () => {
  test("the preview call forwards an options argument", async () => {
    await behaviorPreview("{{horario_atendimento}}");
    await waitFor(() => expect(shownPreview()).toContain("09:00–18:00"));
    expect(shownPreview()).not.toContain("{{horario_atendimento}}");
  });

  test("those options carry an availability, which is what a schedule name needs", async () => {
    await behaviorPreview("{{esta_aberto}} · {{horario_atendimento}}");
    await waitFor(() => expect(shownPreview()).toContain("09:00–18:00"));
    expect(shownPreview()).not.toContain("{{esta_aberto}}");
  });
});

// ONE EXAMPLE PERSON FOR THE WHOLE EDITOR, AND NOBODY REAL IN IT.
//
// Sample contact, company and agent are read from the shared constants the prompt editor uses, never
// written beside the call site: a hand-written literal drifts from the other preview, and the tree
// ships to every deployment, so it must not carry a real customer.
describe("the editor's previews speak to one example person", () => {
  test("both preview call sites read the shared example contact", async () => {
    await behaviorPreview("{{nome_contato}} <{{email_contato}}>");
    const signature = shownPreview();
    fireEvent.click(screen.getByRole("tab", { name: /General/ }));
    await act(async () => {});
    fireEvent.change(screen.getByDisplayValue("Você atende."), {
      target: { value: "Fale com {{nome_contato}} <{{email_contato}}>." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const prompt = (await screen.findByText(/^Fale com/)).textContent ?? "";
    const shared = (text: string) =>
      text.includes(PROMPT_PREVIEW_CONTACT.contactName) &&
      text.includes(PROMPT_PREVIEW_CONTACT.contactEmail);
    expect({ signature: shared(signature), prompt: shared(prompt) }).toEqual({
      signature: true,
      prompt: true,
    });
  });

  test("the signature preview resolves the shared contact, not one of its own", () => {
    expect(preview("{{nome_contato}}")).toContain(
      PROMPT_PREVIEW_CONTACT.contactName,
    );
    expect(preview("{{email_contato}}")).toContain(
      PROMPT_PREVIEW_CONTACT.contactEmail,
    );
  });
});

// THE OPERATOR'S OWN AGENT SIGNS THE PREVIEW.
//
// A stand-in for `{{nome_agente}}` shows a message their agent would never send. A signature is
// mostly those two names, which makes a stand-in there the one place an example costs something.
describe("the preview signs with the operator's own names", () => {
  const vars = signaturePreviewVars("Recepção", "Clínica Moreira");

  test("the agent and the company come from the editor, not the stand-ins", () => {
    // The joined parts are the signature AND the example body, so read the signature's line.
    expect(
      preview("{{nome_agente}}, {{nome_empresa}}", vars).split("\n")[0],
    ).toBe("Recepção, Clínica Moreira");
  });

  // An agent still being named, or a tenant with no company set, still has to preview SOMETHING.
  test("blank names fall back to the stand-ins", () => {
    const blank = signaturePreviewVars("   ", null);
    expect(
      preview("{{nome_agente}}, {{nome_empresa}}", blank).split("\n")[0],
    ).toBe(`${PROMPT_PREVIEW_AGENT}, ${PROMPT_PREVIEW_COMPANY}`);
  });

  // The call site has to hand the component's live map over, not rebuild a fixed one beside it:
  // the name being typed on General is the one the preview signs with.
  test("the tab passes the live map to its preview", async () => {
    await behaviorPreview("{{nome_agente}}");
    await waitFor(() => expect(shownPreview()).toContain("Recepção"));
    fireEvent.click(screen.getByRole("tab", { name: /General/ }));
    await act(async () => {});
    fireEvent.change(screen.getByDisplayValue("Recepção"), {
      target: { value: "Balcão" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /Behavior/ }));
    await act(async () => {});
    expect(shownPreview()).toContain("Balcão");
  });
});

// The preview is where the operator sees what they are buying: a single bubble could not show the
// repetition, nor WHICH of two messages `once` signs.
describe("the preview shows one bubble per message", () => {
  const VARS = signaturePreviewVars("Alex", "Minha Empresa");
  const sig = (over: Record<string, unknown>) => ({
    ...SIGNATURE_DEFAULTS,
    text: "Alex",
    ...over,
  });

  test("all: every message carries it", () => {
    const msgs = signaturePreviewParts(
      sig({ position: "top", frequency: "all" }),
      t,
      VARS,
      OPTS,
    );
    expect(msgs.length).toBeGreaterThan(1);
    for (const parts of msgs) expect(parts[0]).toBe("Alex");
  });

  test("once + top: only the first, and the rest are bare", () => {
    const msgs = signaturePreviewParts(
      sig({ position: "top", frequency: "once" }),
      t,
      VARS,
      OPTS,
    );
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs[0]?.[0]).toBe("Alex");
    expect(msgs.flat().filter((p) => p === "Alex")).toHaveLength(1);
  });

  test("once + bottom: only the last", () => {
    const msgs = signaturePreviewParts(
      sig({ position: "bottom", frequency: "once" }),
      t,
      VARS,
      OPTS,
    );
    expect(msgs.at(-1)?.at(-1)).toBe("Alex");
    expect(msgs.flat().filter((p) => p === "Alex")).toHaveLength(1);
  });

  // THE MESSAGE COUNT FOLLOWS THE SPLIT, not the frequency. With the split off the agent sends one
  // message and the two frequencies are the same thing, so two bubbles would preview a delivery
  // that never happens.
  test("split off: one bubble, whatever the frequency says", () => {
    for (const frequency of ["all", "once"]) {
      const msgs = signaturePreviewParts(
        sig({ position: "top", frequency }),
        t,
        VARS,
        OPTS,
        false,
      );
      expect(msgs).toHaveLength(1);
      expect(msgs.flat().filter((p) => p === "Alex")).toHaveLength(1);
    }
  });

  test("an empty signature previews the bodies alone", () => {
    const msgs = signaturePreviewParts(sig({ text: "  " }), t, VARS, OPTS);
    for (const parts of msgs) expect(parts).toHaveLength(1);
  });
});

// The tab has to hand the preview the SPLIT's own switch, or an operator with the split off reads a
// two-balloon preview of a one-message delivery.
describe("the tab tells its preview whether the reply is split", () => {
  test("the preview call forwards the split switch", async () => {
    await behaviorPreview("Alex", { split: false });
    expect(shownPreview()).not.toContain("Message 1 of");
    cleanup();
    await behaviorPreview("Alex", { split: true });
    expect(shownPreview()).toContain("Message 1 of");
  });
});
