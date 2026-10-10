import { describe, expect, test } from "bun:test";
import {
  newSnoozedStep,
  type SnoozedFollowUpState,
  snoozedFollowUpBlocksSave,
  snoozedFollowUpIssues,
  snoozedFollowUpToForm,
  snoozedFollowUpToStored,
} from "@/client/pages/agents/snoozedFollowUpFormState";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import {
  pickSnoozedCadence,
  SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES,
} from "@/modules/followups/snoozed-settings";
import { followUpStepFields } from "../utils/followup-step-fields";

// The console's "Snoozed follow-up" block (settings.snoozedFollowUp). The Behavior save REPLACES the
// block with what the form holds, so the pair has to carry every field, and what it writes has to be
// what the reader keeps: the reader DROPS a duplicate label and a cadence with no step, so the form
// flags those instead of saving them.

// What MCP `agent_settings_get` answers for a bag: the normalized read of each behaviour block.
const shown = (settings: unknown) =>
  readBehaviorSettings(settings).snoozedFollowUp;

const STORED = {
  enabled: true,
  signature: false,
  cadences: [
    {
      label: null,
      steps: [
        {
          delayValue: 24,
          delayUnit: "hours",
          instructions: "Lembre o pedido de documento.",
        },
        {
          delayValue: 24,
          delayUnit: "hours",
          instructions: "Segundo lembrete.",
        },
        {
          delayValue: 24,
          delayUnit: "hours",
          instructions: "",
          assignLabels: ["sem-retorno"],
          resolve: true,
        },
      ],
    },
    {
      label: "adiar-rapido",
      steps: [{ delayValue: 2, delayUnit: "hours", instructions: "Rápido." }],
    },
  ],
};

const roundTrip = (stored: unknown) =>
  snoozedFollowUpToStored(snoozedFollowUpToForm({ snoozedFollowUp: stored }));

describe("snoozed follow-up form: round trip", () => {
  test("off and empty by default", () => {
    const form = snoozedFollowUpToForm({});
    expect(form).toEqual({ enabled: false, signature: false, cadences: [] });
    expect<unknown>(snoozedFollowUpToStored(form)).toEqual(shown({}));
  });

  test("a saved config comes back exactly as agent_settings_get shows it", () => {
    const before = shown({ snoozedFollowUp: STORED });
    expect<unknown>(roundTrip(STORED)).toEqual(before);
    // ...and saving what the form wrote changes nothing the reader keeps.
    expect(shown({ snoozedFollowUp: roundTrip(STORED) })).toEqual(before);
  });

  test("load, edit, serialize: the edit is what the reader keeps, nothing else moves", () => {
    const form = snoozedFollowUpToForm({ snoozedFollowUp: STORED });
    const edited: SnoozedFollowUpState = {
      ...form,
      signature: true,
      cadences: [
        ...form.cadences,
        {
          label: "  Adiar-Lento ",
          steps: [{ ...newSnoozedStep(), delayValue: "3", delayUnit: "days" }],
        },
      ],
    };
    expect(snoozedFollowUpIssues(edited).any).toBe(false);
    const stored = snoozedFollowUpToStored(edited);
    expect<unknown>(shown({ snoozedFollowUp: stored })).toEqual(stored);
    expect(stored).toEqual({
      ...STORED,
      signature: true,
      cadences: [
        ...STORED.cadences,
        {
          label: "Adiar-Lento",
          steps: [{ delayValue: 3, delayUnit: "days", instructions: "" }],
        },
      ],
    });
  });

  test("the default is drawn first, and no conversation changes cadence for it", () => {
    const defaultLast = {
      enabled: true,
      cadences: [STORED.cadences[1], STORED.cadences[0]],
    };
    const form = snoozedFollowUpToForm({ snoozedFollowUp: defaultLast });
    expect(form.cadences.map((c) => c.label)).toEqual([null, "adiar-rapido"]);
    const before = shown({ snoozedFollowUp: defaultLast });
    const after = shown({ snoozedFollowUp: snoozedFollowUpToStored(form) });
    for (const labels of [[], ["adiar-rapido"], ["ADIAR-RAPIDO"], ["outra"]]) {
      expect(pickSnoozedCadence(after, labels)?.label).toBe(
        pickSnoozedCadence(before, labels)?.label ?? null,
      );
    }
  });

  test("with no default, only labeled cadences are kept, and none is invented", () => {
    const onlyLabeled = { enabled: true, cadences: [STORED.cadences[1]] };
    const stored = roundTrip(onlyLabeled);
    expect(stored.cadences.map((c) => c.label)).toEqual(["adiar-rapido"]);
    expect(pickSnoozedCadence(shown({ snoozedFollowUp: stored }), [])).toBe(
      null,
    );
  });

  // A step is a bag of optional fields rebuilt one by one, so the guard is the field list of
  // `FollowUpStep` itself: a field the snoozed form drops would be deleted on the next save. The
  // appointment exemption has no control here (the ladder has no appointment pause) and is carried.
  test("every step field survives, the ones with no control included", () => {
    const fullStep = {
      delayValue: 3,
      delayUnit: "days",
      instructions: "ask for the document",
      assignLabels: ["aguardando-documento"],
      resolve: true,
      ignoreAppointmentPause: true,
    };
    expect(Object.keys(fullStep).sort()).toEqual(followUpStepFields());
    const stored = roundTrip({
      cadences: [{ label: null, steps: [fullStep] }],
    });
    expect(stored.cadences[0]?.steps[0]).toEqual(fullStep);
  });
});

describe("snoozed follow-up form: validation mirrors the reader", () => {
  const cadence = (label: string | null, steps = [newSnoozedStep()]) => ({
    label,
    steps,
  });
  const form = (
    cadences: SnoozedFollowUpState["cadences"],
  ): SnoozedFollowUpState => ({ enabled: true, signature: false, cadences });

  test("a clean config has no issue, and the reader keeps every cadence of it", () => {
    const f = form([cadence(null), cadence("a"), cadence("b")]);
    expect(snoozedFollowUpIssues(f).any).toBe(false);
    expect(
      shown({ snoozedFollowUp: snoozedFollowUpToStored(f) }).cadences,
    ).toHaveLength(3);
  });

  test("a label used twice, ignoring case, is flagged on the later one", () => {
    const f = form([cadence("Adiar"), cadence("x"), cadence(" adiar ")]);
    const issues = snoozedFollowUpIssues(f);
    expect(issues.cadences.map((c) => c.label)).toEqual([
      null,
      null,
      "duplicate",
    ]);
    expect(issues.any).toBe(true);
    // The reader would have dropped exactly that one.
    expect(
      shown({ snoozedFollowUp: snoozedFollowUpToStored(f) }).cadences.map(
        (c) => c.label,
      ),
    ).toEqual(["Adiar", "x"]);
  });

  test("a second default is a duplicate too", () => {
    const issues = snoozedFollowUpIssues(form([cadence(null), cadence(null)]));
    expect(issues.cadences.map((c) => c.label)).toEqual([null, "duplicate"]);
    expect(issues.any).toBe(true);
  });

  test("a cadence with no step is flagged, not dropped", () => {
    const f = form([cadence(null), cadence("vazia", [])]);
    const issues = snoozedFollowUpIssues(f);
    expect(issues.cadences.map((c) => c.noSteps)).toEqual([false, true]);
    expect(issues.any).toBe(true);
    expect(
      shown({ snoozedFollowUp: snoozedFollowUpToStored(f) }).cadences,
    ).toHaveLength(1);
  });

  test("a labeled cadence with no label picked is flagged: it would read as a second default", () => {
    const issues = snoozedFollowUpIssues(form([cadence(null), cadence("  ")]));
    expect(issues.cadences[1]?.label).toBe("missing");
    expect(issues.any).toBe(true);
  });

  test("the default plus the ten labeled is the limit, and the default does not take a place", () => {
    const labeled = Array.from(
      { length: SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES },
      (_, i) => cadence(`l${i}`),
    );
    const full = form([cadence(null), ...labeled]);
    expect(snoozedFollowUpIssues(full).any).toBe(false);
    expect(
      shown({ snoozedFollowUp: snoozedFollowUpToStored(full) }).cadences,
    ).toHaveLength(SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES + 1);

    const over = snoozedFollowUpIssues(
      form([cadence(null), ...labeled, cadence("extra")]),
    );
    expect(over.tooManyLabeled).toBe(true);
    expect(over.any).toBe(true);
  });

  test("a config that is off has the same checks; the editor decides whether they block", () => {
    const f = { ...form([cadence("a"), cadence("A")]), enabled: false };
    expect(snoozedFollowUpIssues(f).any).toBe(true);
  });
  test("a step stored without a delay loads with the runtime's default, so a save keeps it", () => {
    const bag = {
      snoozedFollowUp: {
        enabled: true,
        signature: false,
        cadences: [{ label: null, steps: [{ instructions: "lembrar" }] }],
      },
    };
    const saved = {
      snoozedFollowUp: snoozedFollowUpToStored(snoozedFollowUpToForm(bag)),
    };
    expect(shown(saved).cadences[0]?.steps[0]?.delayValue).toBe(
      shown(bag).cadences[0]?.steps[0]?.delayValue,
    );
  });

  test("a label longer than the reader keeps is flagged, so two sharing that prefix cannot both save", () => {
    const prefix = "x".repeat(100);
    const issues = snoozedFollowUpIssues(
      form([cadence(`${prefix}a`), cadence(`${prefix}b`)]),
    );
    expect(issues.cadences.map((c) => c.label)).toEqual(["tooLong", "tooLong"]);
    expect(issues.any).toBe(true);
    expect(snoozedFollowUpIssues(form([cadence(prefix)])).any).toBe(false);
  });
  test("a step stored as a non-object is dropped, as the reader drops it, not built into a reminder", () => {
    const bag = {
      snoozedFollowUp: {
        enabled: true,
        signature: false,
        cadences: [
          { label: null, steps: [null, { delayValue: 2, delayUnit: "hours" }] },
          { label: "so-nulo", steps: [null] },
        ],
      },
    };
    const f = snoozedFollowUpToForm(bag);
    expect(f.cadences.map((c) => c.steps.length)).toEqual([1, 0]);
    // The cadence the reader drops is flagged, so a save cannot quietly turn it into a reminder.
    expect(snoozedFollowUpIssues(f).cadences[1]?.noSteps).toBe(true);
  });

  test("every save path asks one predicate: blocked while on with an issue, never while off or monitoring", () => {
    const bad = form([cadence("a"), cadence("A")]);
    expect([
      snoozedFollowUpBlocksSave(bad, "production"),
      snoozedFollowUpBlocksSave({ ...bad, enabled: false }, "production"),
      snoozedFollowUpBlocksSave(bad, "monitoring"),
      snoozedFollowUpBlocksSave(form([cadence("a")]), "production"),
    ]).toEqual([true, false, false, false]);
  });
  test("a labeled cadence saved with no label picked is not written, so it never comes back as the default", () => {
    const f = { ...form([cadence(null), cadence("")]), enabled: false };
    const stored = snoozedFollowUpToStored(f);
    expect(stored.cadences.map((c) => c.label)).toEqual([null]);
    const back = snoozedFollowUpToForm({ snoozedFollowUp: stored });
    expect(back.cadences.filter((c) => c.label === null)).toHaveLength(1);
  });
});
