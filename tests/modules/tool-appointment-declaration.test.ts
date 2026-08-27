import { describe, expect, test } from "bun:test";
import {
  type AppointmentDeclaration,
  extractAppointment,
  isUsablePath,
  readAppointmentDeclaration,
  readPath,
} from "@/modules/tool-definitions/appointment";
import { toolDefinitionCreateSchema } from "@/modules/tool-definitions/service";

// The decision table for what an operator's HTTP tool may declare about the booking its response
// describes (issue #352). The rule lives in one pure function on purpose; a DB-backed test proves
// the wiring, never the rule.

describe("readAppointmentDeclaration", () => {
  const BOOK = {
    action: "book",
    idPath: "data.id",
    startPath: "data.start",
  };
  // What BOOK reads back as. A declaration that names no provider gets the shared "declared" one:
  // an operator with a single booking system has nothing to disambiguate, and the slug is only
  // there to keep two systems' id spaces apart.
  const READ = { ...BOOK, provider: "declared" } as AppointmentDeclaration;

  const CASES: Array<[string, unknown, AppointmentDeclaration | null]> = [
    ["absent", undefined, null],
    ["null", null, null],
    ["an array is not a declaration", [BOOK], null],
    ["a book with both paths", BOOK, { ...READ }],
    [
      "a cancel needs only the id",
      { action: "cancel", idPath: "id" },
      { action: "cancel", provider: "declared", idPath: "id" },
    ],
    // The start is what every reader of an appointment decides liveness by, so a book without one
    // is not a partial declaration to salvage.
    ["a book without a start", { action: "book", idPath: "data.id" }, null],
    ["an unknown action", { action: "reschedule", idPath: "id" }, null],
    // The half-filled editor: paths typed, then the action set back to "neither". Reachable from the
    // form and from any API caller, and a declaration with no action is one no reader can act on.
    [
      "paths without an action at all",
      { idPath: "data.id", startPath: "data.start" },
      null,
    ],
    ["no id path at all", { action: "book", startPath: "s" }, null],
    ["an empty id path", { action: "book", idPath: "", startPath: "s" }, null],
    [
      "a path with a segment nothing can index",
      { action: "book", idPath: "data[0].id", startPath: "s" },
      null,
    ],
    [
      "a summary path rides along when it is usable",
      { ...BOOK, summaryPath: "data.title" },
      { ...READ, summaryPath: "data.title" },
    ],
    // Not a failure: the summary only improves the prompt block.
    [
      "an unusable summary path is dropped, the declaration stands",
      { ...BOOK, summaryPath: "data..title" },
      { ...READ },
    ],
    [
      "reminder offsets are kept, with the confirmation flag",
      { ...BOOK, reminderOffsetsHours: [24, 1], askConfirmationOnLast: true },
      {
        ...READ,
        reminderOffsetsHours: [24, 1],
        askConfirmationOnLast: true,
      },
    ],
    // Absent, empty and all-garbage collapse to the same thing: record the appointment, arm nothing.
    [
      "offsets that are not numbers at all arm nothing",
      { ...BOOK, reminderOffsetsHours: ["24", null, {}] },
      { ...READ },
    ],
    // A number out of range is CLAMPED rather than dropped, because that is what the same
    // normalization does for the settings page, and one rule with two answers is not a rule.
    [
      "an out-of-range offset is clamped, not dropped",
      { ...BOOK, reminderOffsetsHours: [0, -3] },
      { ...READ, reminderOffsetsHours: [1], askConfirmationOnLast: false },
    ],
    [
      "an empty offsets array arms nothing",
      { ...BOOK, reminderOffsetsHours: [] },
      { ...READ },
    ],
    // Every offset is one scheduler job on every booking, so the declaration answers to the SAME
    // clamp the settings page does: [1, 8760] hours, de-duped, far-to-near, five at most. Without
    // it an API-authored declaration turns one tool call into as many inserts as it lists.
    [
      "offsets are clamped and capped like the per-agent config",
      {
        ...BOOK,
        reminderOffsetsHours: [1, 2, 3, 4, 5, 6, 7, 100000, 0.4, 24],
        askConfirmationOnLast: true,
      },
      {
        ...READ,
        reminderOffsetsHours: [8760, 24, 7, 6, 5],
        askConfirmationOnLast: true,
      },
    ],
    // An id is only unique WITHIN the system that issued it, so the slug is half of the identity —
    // and it is stored, so it has to be shaped like a key rather than a sentence.
    [
      "a provider slug is kept, lowercased and trimmed",
      { ...BOOK, provider: "  Feegow-01  " },
      { ...READ, provider: "feegow-01" },
    ],
    [
      "a provider that is not a slug falls back to the shared default",
      { ...BOOK, provider: "Sistema da Clínica!" },
      { ...READ },
    ],
    // Claiming Google's own name would put an operator's id into Google's id space, where the
    // prompt block tells the model to cancel it with calendar_cancel_event.
    [
      "a declaration may not claim to be Google Calendar",
      { ...BOOK, provider: "google_calendar" },
      { ...READ },
    ],
  ];

  for (const [label, raw, expected] of CASES) {
    test(label, () => {
      expect(readAppointmentDeclaration(raw)).toEqual(expected);
    });
  }
});

describe("readPath", () => {
  const BODY = {
    data: { id: "ap_1", start: "2026-09-02T14:00:00-03:00", n: 42, title: "" },
    items: [{ id: "first" }, { id: "second" }],
    nested: { deep: { value: "x" } },
    nul: null,
  };

  const CASES: Array<[string, string, string | undefined]> = [
    ["a plain key", "nested.deep.value", "x"],
    ["a nested object", "data.id", "ap_1"],
    ["an array index", "items.1.id", "second"],
    // A number is a legitimate id in plenty of systems, and coercing it here is the alternative to
    // making every operator of such a system unable to declare anything.
    ["a numeric value becomes its digits", "data.n", "42"],
    ["an empty string is not a value", "data.title", undefined],
    ["a missing key", "data.nope", undefined],
    ["walking through null", "nul.anything", undefined],
    // Pointing at the wrong LEVEL is a mistake to report, not a value to coerce.
    ["an object at the end", "data", undefined],
    ["an array at the end", "items", undefined],
    ["a non-numeric index into an array", "items.id", undefined],
  ];

  for (const [label, path, expected] of CASES) {
    test(label, () => {
      expect(readPath(BODY, path)).toBe(expected as string);
    });
  }
});

describe("extractAppointment", () => {
  const decl = readAppointmentDeclaration({
    action: "book",
    idPath: "data.id",
    startPath: "data.start",
    summaryPath: "data.title",
  }) as AppointmentDeclaration;

  test("a body that answers every path", () => {
    const r = extractAppointment(decl, {
      data: {
        id: "ap_1",
        start: "2026-09-02T14:00:00-03:00",
        title: "Consulta",
      },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        action: "book",
        provider: "declared",
        externalId: "ap_1",
        startISO: "2026-09-02T14:00:00-03:00",
        summary: "Consulta",
      },
    });
  });

  test("the missing paths are NAMED, because the operator has to know which one to fix", () => {
    const r = extractAppointment(decl, { data: { title: "Consulta" } });
    expect(r).toEqual({ ok: false, missing: ["data.id", "data.start"] });
  });

  test("a summary that does not resolve does not sink the registration", () => {
    const r = extractAppointment(decl, {
      data: { id: "ap_2", start: "2026-09-02T14:00:00-03:00" },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.summary).toBeUndefined();
    expect(r.ok && r.value.externalId).toBe("ap_2");
  });

  test("a cancel asks for the id and nothing else", () => {
    const cancel = readAppointmentDeclaration({
      action: "cancel",
      idPath: "id",
    }) as AppointmentDeclaration;
    expect(extractAppointment(cancel, { id: "ap_1" })).toEqual({
      ok: true,
      value: { action: "cancel", provider: "declared", externalId: "ap_1" },
    });
    expect(extractAppointment(cancel, {})).toEqual({
      ok: false,
      missing: ["id"],
    });
  });
});

describe("isUsablePath", () => {
  test("accepts what an operator writes and refuses what nothing can walk", () => {
    for (const ok of [
      "id",
      "data.id",
      "a.b.c.0.d",
      "kebab-case",
      "_x",
      "a$b",
    ]) {
      expect(isUsablePath(ok)).toBe(true);
    }
    for (const bad of ["", ".", "a..b", "a.", "data[0].id", "a b", 7, null]) {
      expect(isUsablePath(bad)).toBe(false);
    }
  });
});

describe("the API refuses a declaration the runtime would ignore", () => {
  // A shape stored and then silently skipped is the failure this feature exists to remove: the
  // operator sees a saved tool, the agent books, and nothing anywhere says why no appointment
  // appeared. So the write path validates with the SAME reader the runtime uses.
  const base = {
    name: "feegow_create_appointment",
    label: "Marcar consulta",
    method: "POST",
    urlTemplate: "https://api.example.com/appointments",
    allowedHosts: ["api.example.com"],
  };

  const REFUSED: Array<[string, unknown]> = [
    ["a book with no start path", { action: "book", idPath: "data.id" }],
    ["an unknown action", { action: "reschedule", idPath: "data.id" }],
    [
      "a path nothing can walk",
      { action: "book", idPath: "data[0].id", startPath: "data.start" },
    ],
    ["no action at all", { idPath: "data.id", startPath: "data.start" }],
  ];

  for (const [label, appointment] of REFUSED) {
    test(`refuses ${label}`, () => {
      const r = toolDefinitionCreateSchema.safeParse({ ...base, appointment });
      expect(r.success).toBe(false);
      // And the refusal says what a correct one looks like, because the operator's only next move
      // is to write one.
      const message = r.success ? "" : JSON.stringify(r.error.issues);
      expect(message).toContain("idPath");
      expect(message).toContain("startPath");
    });
  }

  test("accepts a well-formed one, and accepts none at all", () => {
    expect(
      toolDefinitionCreateSchema.safeParse({
        ...base,
        appointment: {
          action: "book",
          idPath: "data.id",
          startPath: "data.start",
        },
      }).success,
    ).toBe(true);
    expect(
      toolDefinitionCreateSchema.safeParse({ ...base, appointment: null })
        .success,
    ).toBe(true);
    expect(toolDefinitionCreateSchema.safeParse(base).success).toBe(true);
  });
});
