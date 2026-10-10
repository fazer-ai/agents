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
});
