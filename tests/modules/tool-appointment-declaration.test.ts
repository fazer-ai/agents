import { describe, expect, test } from "bun:test";
import {
  type AppointmentDeclaration,
  extractAppointment,
  isUsablePath,
  readAppointmentDeclaration,
  readPath,
  sampleLeaves,
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
    // Both of the next two used to fall back to the shared default, and that WAS the defect (round
    // 14): a typo on the booking tool moved it into `declared` while its paired cancel tool, spelled
    // correctly, kept `feegow`, so the cancellation never found the record. Refusing is what the form
    // has done since round 3, and the reader is what the REST and MCP paths go through.
    [
      "a provider that is not a slug is refused, not defaulted",
      { ...BOOK, provider: "Sistema da Clínica!" },
      null,
    ],
    // Claiming Google's own name would put an operator's id into Google's id space, where the
    // prompt block tells the model to cancel it with calendar_cancel_event.
    [
      "a declaration may not claim to be Google Calendar",
      { ...BOOK, provider: "google_calendar" },
      null,
    ],
  ];

  for (const [label, raw, expected] of CASES) {
    test(label, () => {
      expect(readAppointmentDeclaration(raw)).toEqual(expected);
    });
  }
});

// Every start in this file already carries an offset, so there is nothing for the resolver to
// decide: it says "this value is already unambiguous". The resolution itself is exercised where
// the timezone actually lives (tests/graph/tools-http-appointment.test.ts).
const KEEP = (wall: string) => wall;

describe("readPath", () => {
  const BODY = {
    data: { id: "ap_1", start: "2026-09-02T14:00:00-03:00", n: 42, title: "" },
    // What a 64-bit id looks like AFTER JSON.parse: the digits are already gone by the time any of
    // this runs, which is exactly why it cannot be coerced into an id.
    big: JSON.parse('{"id": 9007199254740993}'),
    huge: { id: 1e21 },
    safe: { id: 9007199254740991 },
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
    // (#352, round 6) An integer past 2^53 reaches here ALREADY rounded. Coercing it would mint an
    // id the operator's system never issued, one digit off the real booking and therefore able to
    // land on the one beside it: a later cancel would then retire another customer's appointment.
    // Reported as unresolved instead, so the operator is told to point at the string id.
    ["an id past 2^53 was already rounded", "big.id", undefined],
    ["and so was one in exponent range", "huge.id", undefined],
    // The control, and the boundary itself: the largest integer JSON.parse still round-trips.
    ["the largest exact integer still reads", "safe.id", "9007199254740991"],
  ];

  for (const [label, path, expected] of CASES) {
    test(label, () => {
      expect(readPath(BODY, path)).toBe(expected as string);
    });
  }
});

// (#352) Picking beats typing, and the reason is what the form's gates CANNOT catch: a well-formed
// path aimed at the wrong key passes every check and reads nothing, silently. The offer is only
// trustworthy if it can never include a leaf the reader would then refuse, so these assert exactly
// that agreement, in both directions.
// (#352, round 12) A path addresses the RESPONSE, and `sampleLeaves` already says so by walking
// `Object.keys` — own properties. `readPath` walked the prototype chain, so the two readers of the
// same question disagreed about what a path may address, and this PR's whole argument for the picker
// is that they must not.
//
// The disagreement is not reachable from a real body: JSON.parse only ever produces plain objects,
// and nothing on Object.prototype is a scalar (measured: its one non-function own property is
// `__proto__`, an accessor returning an object), so the reviewer's `constructor.name` returns
// undefined because the intermediate is a function and the walk already refuses one. What is pinned
// here is the CONTRACT, on the only input that can express it.
describe("a path addresses the response, not JavaScript", () => {
  test("readPath does not walk the prototype chain", () => {
    const body = Object.create({ inherited: "from the prototype" }) as Record<
      string,
      unknown
    >;
    body.own = "from the response";
    expect(readPath(body, "own")).toBe("from the response");
    expect(readPath(body, "inherited")).toBeUndefined();
    // The whole subtree, not just the leaf: an inherited object is not a place a path may pass through.
    const nested = Object.create({ deep: { id: "x" } }) as Record<
      string,
      unknown
    >;
    expect(readPath(nested, "deep.id")).toBeUndefined();
  });

  test("and neither does the picker, which is the agreement that matters", () => {
    const body = Object.create({ inherited: "from the prototype" }) as Record<
      string,
      unknown
    >;
    body.own = "from the response";
    expect(sampleLeaves(body)).toEqual([
      { path: "own", value: "from the response" },
    ]);
  });
});

describe("sampleLeaves", () => {
  test("walks objects and arrays, in document order, with array positions as segments", () => {
    expect(
      sampleLeaves({
        data: { id: "ap_1", nested: { deep: "x" } },
        items: [{ id: "first" }, { id: "second" }],
      }),
    ).toEqual([
      { path: "data.id", value: "ap_1" },
      { path: "data.nested.deep", value: "x" },
      { path: "items.0.id", value: "first" },
      { path: "items.1.id", value: "second" },
    ]);
  });

  test("offers only what readPath would return, and every offer round-trips", () => {
    const body = {
      ok: true,
      count: 42,
      title: "",
      note: null,
      obj: { a: 1 },
      list: [1],
      // Through JSON.parse, never as a source literal: biome refuses the literal for the very reason
      // this case exists, which is that the value is already rounded before anything reads it.
      ...(JSON.parse('{"huge": 9007199254740993}') as Record<string, unknown>),
      id: "ap_1",
    };
    // Booleans, nulls, empty strings, and the already-rounded integer are all absent, because a path
    // ending on one of them reads as no value at all.
    expect(sampleLeaves(body).map((l) => l.path)).toEqual([
      "count",
      "obj.a",
      "list.0",
      "id",
    ]);
    // The agreement itself: every offer, fed back to the reader, returns the value that was shown.
    for (const leaf of sampleLeaves(body)) {
      expect(readPath(body, leaf.path)).toBe(leaf.value);
    }
  });

  test("a key the path grammar cannot address is not offered", () => {
    // `a.b` and `has space` cannot be written as a segment, so a path through them would name
    // something else entirely (or nothing). The sibling that CAN be addressed still is.
    const body = { "a.b": "x", "has space": "y", fine: "z", "d-1_$": "w" };
    expect(sampleLeaves(body)).toEqual([
      { path: "fine", value: "z" },
      { path: "d-1_$", value: "w" },
    ]);
  });

  test("reaching the cap ENDS the traversal, it does not just stop pushing", () => {
    // The cap is only a bound if it stops the walk. Measured on the LOOP, not on the leaves: with
    // each recursive call merely returning, the container is still enumerated end to end, which for
    // a pasted 50k-row response is the browser freezing while the operator waits. The Proxy counts
    // the index reads the traversal actually performs.
    const counted = (target: object) => {
      let reads = 0;
      const proxy = new Proxy(target, {
        get(t, prop, recv) {
          if (typeof prop === "string" && prop !== "length") reads += 1;
          return Reflect.get(t, prop, recv);
        },
      });
      return { proxy, reads: () => reads };
    };

    const arr = counted(
      Array.from({ length: 5_000 }, (_, i) => ({ id: `r${i}` })),
    );
    expect(sampleLeaves({ rows: arr.proxy }, 5).length).toBe(5);
    expect(arr.reads()).toBeLessThan(20);

    const obj = counted(
      Object.fromEntries(
        Array.from({ length: 5_000 }, (_, i) => [`k${i}`, `v${i}`]),
      ),
    );
    expect(sampleLeaves({ bag: obj.proxy }, 5).length).toBe(5);
    expect(obj.reads()).toBeLessThan(20);
  });

  test("bounded on count and on depth", () => {
    const wide = {
      rows: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })),
    };
    expect(sampleLeaves(wide).length).toBe(200);
    expect(sampleLeaves(wide, 3).map((l) => l.path)).toEqual([
      "rows.0.id",
      "rows.1.id",
      "rows.2.id",
    ]);
    let deep: unknown = "bottom";
    for (let i = 0; i < 20; i++) deep = { k: deep };
    expect(sampleLeaves(deep)).toEqual([]);
  });

  test("a scalar at the root has no path to offer", () => {
    expect(sampleLeaves("just a string")).toEqual([]);
    expect(sampleLeaves(null)).toEqual([]);
  });
});

// (#352, round 9) What a declared response hands over is bounded, and the three fields answer
// differently because the question is whether the consumer needs the exact bytes.
// (#352, round 14) OMITTED and SUPPLIED-BUT-INVALID are different answers. Collapsing them meant a
// typo on the booking tool moved it into the shared namespace while its paired cancel tool, spelled
// correctly, kept its own — and the cancellation then never found the record. The form has refused
// this since round 3; the reader is what the REST and MCP paths go through.
describe("readAppointmentDeclaration and an explicit provider", () => {
  const withProvider = (provider: unknown) =>
    readAppointmentDeclaration({
      action: "cancel",
      idPath: "data.id",
      ...(provider === undefined ? {} : { provider }),
    });

  test("omitted takes the shared default", () => {
    expect(withProvider(undefined)?.provider).toBe("declared");
    // Null is how a caller CLEARS it, which is the same answer as never naming one.
    expect(withProvider(null)?.provider).toBe("declared");
  });

  test("a valid slug is kept", () => {
    expect(withProvider("feegow")?.provider).toBe("feegow");
  });

  test("a malformed one is REFUSED, not quietly defaulted", () => {
    expect(withProvider("Feegow Clínica!")).toBeNull();
    expect(withProvider(42)).toBeNull();
    expect(withProvider("")).toBeNull();
  });

  test("and so is Google's own name, which is the reserved one", () => {
    expect(withProvider("google_calendar")).toBeNull();
  });
});

describe("extractAppointment bounds what it persists", () => {
  const decl = readAppointmentDeclaration({
    action: "book",
    idPath: "data.id",
    startPath: "data.start",
    summaryPath: "data.title",
  }) as AppointmentDeclaration;
  const start = "2026-09-02T14:00:00-03:00";

  test("an oversized id is REFUSED, and the path is named", () => {
    // Not clipped: a clipped id is a different booking, and the cancel tool would never find this
    // one. It also could not key the unique index it goes into — a btree entry tops out near 2704
    // bytes, so the write would throw and the appointment would silently never be recorded.
    const r = extractAppointment(
      decl,
      {
        data: { id: "x".repeat(201), start, title: "Consulta" },
      },
      KEEP,
    );
    expect(r).toEqual({ ok: false, missing: ["data.id"] });
    // The boundary is inclusive, and the control: one char shorter goes through untouched.
    const ok = extractAppointment(
      decl,
      {
        data: { id: "x".repeat(200), start, title: "Consulta" },
      },
      KEEP,
    );
    expect(ok.ok && ok.value.externalId).toBe("x".repeat(200));
  });

  test("an oversized start is refused too: nothing that long is an instant", () => {
    const r = extractAppointment(
      decl,
      {
        data: { id: "ap_1", start: "2".repeat(101), title: "Consulta" },
      },
      KEEP,
    );
    expect(r).toEqual({ ok: false, missing: ["data.start"] });
  });

  // (#352, round 11) The SAME split answers the other thing a value can be wrong about. `external_id`
  // is text and the scheduler payload is jsonb; both refuse a NUL and both refuse half a character,
  // so an unstoreable value does not degrade anything — the write throws and the booking is never
  // recorded at all.
  test("an id the database cannot store is refused, not repaired", () => {
    // Repairing would be the worse answer HERE specifically: dropping the NUL mints an id that no
    // longer matches what the operator's cancel tool will answer with, so the booking could never be
    // retired. A refusal names the path and the operator points somewhere else.
    const r = extractAppointment(
      decl,
      {
        data: { id: "ap\u00001", start, title: "Consulta" },
      },
      KEEP,
    );
    expect(r).toEqual({ ok: false, missing: ["data.id"] });
    // Half a character is refused the same way, and it is the half that survives JSON.parse.
    const lone = extractAppointment(
      decl,
      {
        data: { id: JSON.parse('"ap\\ud800"'), start, title: "Consulta" },
      },
      KEEP,
    );
    expect(lone).toEqual({ ok: false, missing: ["data.id"] });
  });

  test("an unstoreable start is refused too", () => {
    const r = extractAppointment(
      decl,
      {
        data: { id: "ap_1", start: `${start}\u0000`, title: "Consulta" },
      },
      KEEP,
    );
    expect(r).toEqual({ ok: false, missing: ["data.start"] });
  });

  test("an unstoreable summary is REPAIRED, and the booking still registers", () => {
    // The opposite answer, for the same reason as the length: refusing the whole registration over a
    // broken title would trade the follow-up pause for a nicer sentence, and the summary only ever
    // reaches the model.
    const r = extractAppointment(
      decl,
      {
        data: {
          id: "ap_1",
          start,
          title: JSON.parse('"Cons\\u0000ulta \\ud800"'),
        },
      },
      KEEP,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.summary).toBe("Consulta \ufffd");
    expect(r.ok && r.value.externalId).toBe("ap_1");
  });

  test("an oversized summary is CLIPPED, and the booking still registers", () => {
    // The opposite answer, for the opposite reason: the summary only makes the prompt block read
    // better, so losing the tail costs nothing — while refusing would trade the follow-up pause for
    // a nicer sentence. Unclipped it is the worse of the two, since nothing downstream errors and it
    // is re-rendered into every later turn.
    const r = extractAppointment(
      decl,
      {
        data: { id: "ap_1", start, title: "T".repeat(500) },
      },
      KEEP,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.summary).toBe("T".repeat(200));
    expect(r.ok && r.value.externalId).toBe("ap_1");
  });
});

describe("extractAppointment", () => {
  const decl = readAppointmentDeclaration({
    action: "book",
    idPath: "data.id",
    startPath: "data.start",
    summaryPath: "data.title",
  }) as AppointmentDeclaration;

  test("a body that answers every path", () => {
    const r = extractAppointment(
      decl,
      {
        data: {
          id: "ap_1",
          start: "2026-09-02T14:00:00-03:00",
          title: "Consulta",
        },
      },
      KEEP,
    );
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
    const r = extractAppointment(decl, { data: { title: "Consulta" } }, KEEP);
    expect(r).toEqual({ ok: false, missing: ["data.id", "data.start"] });
  });

  test("a summary that does not resolve does not sink the registration", () => {
    const r = extractAppointment(
      decl,
      {
        data: { id: "ap_2", start: "2026-09-02T14:00:00-03:00" },
      },
      KEEP,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.summary).toBeUndefined();
    expect(r.ok && r.value.externalId).toBe("ap_2");
  });

  test("a cancel asks for the id and nothing else", () => {
    const cancel = readAppointmentDeclaration({
      action: "cancel",
      idPath: "id",
    }) as AppointmentDeclaration;
    expect(extractAppointment(cancel, { id: "ap_1" }, KEEP)).toEqual({
      ok: true,
      value: { action: "cancel", provider: "declared", externalId: "ap_1" },
    });
    expect(extractAppointment(cancel, {}, KEEP)).toEqual({
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
