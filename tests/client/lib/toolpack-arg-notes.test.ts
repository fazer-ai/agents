import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  toolpackArgNote,
  withToolpackArgNotes,
} from "@/client/lib/toolpackTools";
import { getToolpackToolViews } from "@/modules/integrations/toolpacks";
import "@/modules/integrations/toolpacks/google-calendar";

// Issue #118. A toolpack argument's `.describe()` is read by two audiences with opposite needs: the
// model, on every turn the tool is bound, and the operator, once, in the console's argument list.
// The `calendarId` sentence about when the argument appears belonged only to the second one, and was
// being paid for by the first.

// The console passes i18next's `t`, which falls back to the default string when a key is missing.
const t = ((_key: string, fallback: string) =>
  fallback) as unknown as TFunction;

const CALENDAR_TOOLS = [
  "calendar_list_events",
  "calendar_check_availability",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_cancel_event",
  "calendar_confirm_appointment",
];

// The phrases that say WHEN an argument is offered. Any argument carrying one is paying model tokens
// to state a condition its own presence already guarantees.
const APPEARANCE_PHRASES = [
  "only appears",
  "only offered",
  "integration allows",
  "is absent",
  "has not pinned",
  "has NOT pinned",
];

describe("the calendarId argument's two audiences", () => {
  // NOTE: the tautology, stated as a property rather than as a string match on the old sentence: the
  // model can only ever READ this text in the case where the condition it describes is already true,
  // because calendarArgSchema removes the argument whenever the integration has one calendar.
  // Asked of EVERY argument, not just calendarId: the second conditional schema (slotDurationArgSchema)
  // arrived with the same sentence on a different argument, and a test naming one argument would have
  // let it through.
  test("no calendar tool's schema explains when an argument appears", () => {
    const views = getToolpackToolViews("GOOGLE_CALENDAR");
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      for (const arg of view.args) {
        if (!arg.description) continue;
        for (const phrase of APPEARANCE_PHRASES) {
          expect(arg.description).not.toContain(phrase);
        }
      }
    }
  });

  // The other half of #118: every argument a conditional schema can REMOVE needs the note, or the
  // operator sees an argument in the console that their agent never receives and cannot find out why.
  test("every argument a conditional schema removes carries an operator note", () => {
    for (const [tool, arg] of [
      ["calendar_check_availability", "calendarId"],
      ["calendar_check_availability", "slotDurationMinutes"],
    ] as const) {
      expect(toolpackArgNote(tool, arg, t)).toBeTruthy();
    }
  });

  test("the appointment length note names the console setting that puts the arg back", () => {
    const note = toolpackArgNote(
      "calendar_check_availability",
      "slotDurationMinutes",
      t,
    );
    expect(note).toContain("Let the AI choose");
    // The spacing has no such setting, so it has no argument and needs no note.
    expect(
      toolpackArgNote("calendar_check_availability", "granularityMinutes", t),
    ).toBeNull();
    const views = getToolpackToolViews("GOOGLE_CALENDAR");
    const availability = views.find(
      (v) => v.name === "calendar_check_availability",
    );
    expect(availability?.args.map((a) => a.name)).not.toContain(
      "granularityMinutes",
    );
  });

  test("every calendar tool that takes the argument still tells the model how to fill it", () => {
    const views = getToolpackToolViews("GOOGLE_CALENDAR");
    const withArg = views.filter((v) =>
      v.args.some((a) => a.name === "calendarId"),
    );
    expect(withArg.length).toBeGreaterThan(0);
    for (const view of withArg) {
      const arg = view.args.find((a) => a.name === "calendarId");
      expect(arg?.description).toContain("<allowed_calendars>");
    }
  });

  test("the operator's half is served by the note, on every calendar tool", () => {
    for (const name of CALENDAR_TOOLS) {
      expect(toolpackArgNote(name, "calendarId", t)).toContain(
        "several calendars",
      );
    }
  });

  test("the note is scoped: not another argument, not another toolpack", () => {
    expect(toolpackArgNote("calendar_create_event", "start", t)).toBeNull();
    expect(toolpackArgNote("asaas_create_pix_charge", "calendarId", t)).toBe(
      null,
    );
  });

  // NOTE: the console renders the arg description as the pill's tooltip, so the note has to arrive
  // fused with it — a note kept in a separate field would simply not be shown.
  test("the note is appended to the description the pill shows", () => {
    const [withNote, untouched] = withToolpackArgNotes(
      "calendar_create_event",
      [
        { name: "calendarId", description: "Which calendar to act on." },
        { name: "start", description: "ISO 8601." },
      ],
      t,
    );
    expect(withNote?.description).toStartWith("Which calendar to act on.");
    expect(withNote?.description).toContain("several calendars");
    expect(untouched?.description).toBe("ISO 8601.");
  });

  test("an argument with no description of its own still gets the note", () => {
    const [only] = withToolpackArgNotes(
      "calendar_cancel_event",
      [{ name: "calendarId" } as { name: string; description?: string }],
      t,
    );
    expect(only?.description).toContain("several calendars");
  });
});
