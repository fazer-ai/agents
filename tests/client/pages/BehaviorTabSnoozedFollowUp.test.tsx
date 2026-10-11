/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import {
  newSnoozedStep,
  type SnoozedFollowUpState,
} from "@/client/pages/agents/snoozedFollowUpFormState";
import { behaviorTabProps } from "./behaviorTabProps";

// The snoozed follow-up section: what the reader would drop is said on the cadence and holds Save,
// and only while the operator can see it.
//
// Every assertion reduces to a number or a boolean BEFORE expect: a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ labels: [], accountCount: 1 }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderWith(
  snoozedFollowUp: SnoozedFollowUpState,
  mode: "production" | "monitoring" = "production",
): void {
  render(
    <BehaviorTab
      {...behaviorTabProps({ snoozedFollowUp, mode, dirty: true })}
    />,
  );
}

const count = (re: RegExp) => screen.queryAllByText(re).length;
const saveDisabled = () =>
  (screen.getByRole("button", { name: /^(Save|Salvar)$/ }) as HTMLButtonElement)
    .disabled;

const DUPLICATE = /already uses this label|já usa esta etiqueta/i;
const NO_STEPS = /reminds nobody|não lembra ninguém/i;
const NO_DEFAULT = /No default cadence|Sem cadência padrão/i;
const EVERY = /every snoozed conversation|toda conversa adiada/i;
const BELOW = /none of the labels below|nenhuma das etiquetas abaixo/i;

const cadence = (label: string | null, steps = [newSnoozedStep()]) => ({
  label,
  steps,
});

describe("snoozed follow-up section", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  // With no labeled cadence on screen, the default's hint cannot point at "the labels below".
  test("the default alone says it covers every snoozed conversation", () => {
    renderWith({ enabled: true, signature: false, cadences: [cadence(null)] });
    expect(count(EVERY)).toBe(1);
    expect(count(BELOW)).toBe(0);
  });

  test("next to labeled cadences the default points at their labels", () => {
    renderWith({
      enabled: true,
      signature: false,
      cadences: [cadence(null), cadence("adiar")],
    });
    expect(count(EVERY)).toBe(0);
    expect(count(BELOW)).toBe(1);
  });

  test("a label taken twice is said on the cadence and holds Save", () => {
    renderWith({
      enabled: true,
      signature: false,
      cadences: [cadence(null), cadence("adiar"), cadence("ADIAR")],
    });
    expect(count(DUPLICATE)).toBe(1);
    expect(saveDisabled()).toBe(true);
  });

  test("a cadence with no step is said and holds Save", () => {
    renderWith({
      enabled: true,
      signature: false,
      cadences: [cadence(null), cadence("adiar", [])],
    });
    expect(count(NO_STEPS)).toBe(1);
    expect(saveDisabled()).toBe(true);
  });

  test("with no default, the section says only labeled conversations are chased", () => {
    renderWith({
      enabled: true,
      signature: false,
      cadences: [cadence("adiar")],
    });
    expect(count(NO_DEFAULT)).toBe(1);
    expect(saveDisabled()).toBe(false);
  });

  test("at the label limit the add button gives way to a hint naming the limit", () => {
    const labeled = (n: number) =>
      Array.from({ length: n }, (_, i) => cadence(`etiqueta-${i}`));
    const addButtons = () =>
      screen.queryAllByRole("button", {
        name: /Add cadence by label|Adicionar cadência por etiqueta/,
      }).length;
    const AT_LIMIT =
      /^(Up to 10 cadences by label\.|Até 10 cadências por etiqueta\.)$/;

    renderWith({ enabled: true, signature: false, cadences: labeled(9) });
    expect(addButtons()).toBe(1);
    expect(count(AT_LIMIT)).toBe(0);
    cleanup();

    renderWith({ enabled: true, signature: false, cadences: labeled(10) });
    expect(addButtons()).toBe(0);
    expect(count(AT_LIMIT)).toBe(1);
    expect(saveDisabled()).toBe(false);
    cleanup();

    // Past the limit the refusal already says it, and holds Save: no second sentence beside it.
    renderWith({ enabled: true, signature: false, cadences: labeled(11) });
    expect(addButtons()).toBe(0);
    expect(count(AT_LIMIT)).toBe(0);
    expect(count(/Remove the extra ones|Remova as que sobram/)).toBe(1);
  });

  test("a clean config saves", () => {
    renderWith({
      enabled: true,
      signature: false,
      cadences: [cadence(null), cadence("adiar")],
    });
    expect(count(DUPLICATE) + count(NO_STEPS) + count(NO_DEFAULT)).toBe(0);
    expect(saveDisabled()).toBe(false);
  });

  // Hidden fields never hold Save: switched off, the cadences are not drawn, and a watcher does not
  // draw the section at all.
  test("switched off, or on a watcher, a bad cadence does not hold Save", () => {
    const bad = [cadence("adiar"), cadence("adiar")];
    renderWith({ enabled: false, signature: false, cadences: bad });
    expect(count(DUPLICATE)).toBe(0);
    expect(saveDisabled()).toBe(false);
    cleanup();
    renderWith(
      { enabled: true, signature: false, cadences: bad },
      "monitoring",
    );
    expect(saveDisabled()).toBe(false);
  });
  test("the schedule its reminders fire in is shown with the snoozed ladder on, even with the follow-up off", () => {
    const hint =
      /Shared with the follow-up above|O mesmo horário do follow-up acima/i;
    renderWith({ enabled: true, signature: false, cadences: [cadence(null)] });
    const on = count(hint);
    cleanup();
    renderWith({ enabled: false, signature: false, cadences: [cadence(null)] });
    const off = count(hint);
    expect([on, off]).toEqual([1, 0]);
  });
});
