import { describe, expect, test } from "bun:test";
import {
  type AppointmentBookedNotice,
  appointmentSideEffects,
} from "@/modules/appointments/side-effect";

// The boundary where a booking's side effect stops being an exception and becomes a line an operator
// reads. Every case here is a failure that the TOOL still reported as success to the model, so the
// only thing left to get right is the report — and a report that names the wrong tool sends the
// operator to an integration they may not even have configured (issue #352).
//
// The writes are injected: the question is what the REPORT says, and a test that needed a broken
// database to ask it would not be asking it.

type Report = {
  tool: string;
  phase: string;
  detail?: Record<string, unknown>;
  message: string;
};

const NOTICE: AppointmentBookedNotice = {
  eventId: "ap_1",
  startISO: "2099-09-02T14:00:00-03:00",
  credentialRef: null,
  reminders: null,
  summary: null,
  calendarLabel: null,
};

function harness(
  over: {
    book?: () => Promise<{ record: string; remindersArmed: number }>;
    cancel?: () => Promise<void>;
  } = {},
) {
  const reports: Report[] = [];
  const bookCalls: Array<Record<string, unknown>> = [];
  const cancelCalls: Array<unknown[]> = [];
  const fx = appointmentSideEffects({
    tenantId: 7n,
    threadId: "7:1:42",
    report: (e) =>
      reports.push({
        tool: e.tool,
        phase: e.phase,
        detail: e.detail,
        message: e.err instanceof Error ? e.err.message : String(e.err),
      }),
    book: (async (args: Record<string, unknown>) => {
      bookCalls.push(args);
      return over.book
        ? await over.book()
        : { record: "recorded", remindersArmed: 0 };
    }) as never,
    cancel: (async (...args: unknown[]) => {
      cancelCalls.push(args);
      if (over.cancel) await over.cancel();
    }) as never,
  });
  return { fx, reports, bookCalls, cancelCalls };
}

describe("appointment side effects: what the report names", () => {
  test("a write that throws is reported against the tool that booked", async () => {
    const h = harness({
      book: async () => {
        throw new Error("scheduler unavailable");
      },
    });
    await h.fx.booked({ ...NOTICE, tool: "feegow_create_appointment" });
    expect(h.reports).toEqual([
      {
        tool: "feegow_create_appointment",
        phase: "appointment_booked",
        detail: { eventId: "ap_1" },
        message: "scheduler unavailable",
      },
    ]);
  });

  // The Calendar toolpack cannot name which of its tools called, so the FAMILY name is the default —
  // and it must stay the default, or the two integrations swap places in the Logs page.
  test("a caller that names no tool is still the Calendar toolpack", async () => {
    const h = harness({
      book: async () => {
        throw new Error("boom");
      },
    });
    await h.fx.booked(NOTICE);
    expect(h.reports[0]?.tool).toBe("google_calendar");
  });

  // A start the platform cannot judge yields NO record, so the pause, the console indicator and the
  // prompt block all behave as if there were no appointment. The operator's fix is the start path,
  // which is in the tool definition this names.
  test("an unreadable start is its own phase, named after the same tool", async () => {
    const h = harness({
      book: async () => ({ record: "unreadable-start", remindersArmed: 0 }),
    });
    await h.fx.booked({ ...NOTICE, tool: "feegow_create_appointment" });
    expect(h.reports[0]?.phase).toBe("appointment_record");
    expect(h.reports[0]?.tool).toBe("feegow_create_appointment");
    expect(h.reports[0]?.message).toContain("2099-09-02");
  });

  test("a recorded booking reports nothing at all", async () => {
    const h = harness();
    await h.fx.booked({ ...NOTICE, tool: "feegow_create_appointment" });
    expect(h.reports).toEqual([]);
  });

  test("a cancel that throws is reported against the tool that cancelled", async () => {
    const h = harness({
      cancel: async () => {
        throw new Error("connection reset");
      },
    });
    await h.fx.cancel("ap_1", {
      provider: "feegow",
      tool: "feegow_cancel_appointment",
    });
    expect(h.reports).toEqual([
      {
        tool: "feegow_cancel_appointment",
        phase: "appointment_cancel",
        detail: { eventId: "ap_1" },
        message: "connection reset",
      },
    ]);
  });

  test("a cancel with no tool named is the Calendar toolpack", async () => {
    const h = harness({
      cancel: async () => {
        throw new Error("boom");
      },
    });
    await h.fx.cancel("ev_1");
    expect(h.reports[0]?.tool).toBe("google_calendar");
  });

  // The provider is half the appointment's identity, so it has to survive the wiring: a booking that
  // arrives here as "feegow" and is written as Google collides with Google's id space, and a cancel
  // that loses it reaches no record at all.
  test("the provider travels through, and defaults to Google on both sides", async () => {
    const h = harness();
    await h.fx.booked({ ...NOTICE, provider: "feegow" });
    await h.fx.booked({ ...NOTICE, eventId: "ev_2" });
    expect(h.bookCalls.map((c) => c.provider)).toEqual(["feegow", undefined]);

    await h.fx.cancel("ap_1", { provider: "feegow" });
    await h.fx.cancel("ev_2");
    expect(h.cancelCalls.map((c) => c[3])).toEqual([
      "feegow",
      "google_calendar",
    ]);
  });

  // Nothing here may throw into the turn: the tool already answered the model, and the booking is
  // real in a system this platform does not own.
  test("no failure reaches the caller, with or without a reporter", async () => {
    const thrower = { book: async () => Promise.reject(new Error("x")) };
    await expect(harness(thrower).fx.booked(NOTICE)).resolves.toBeUndefined();
    const silent = appointmentSideEffects({
      tenantId: 7n,
      threadId: "7:1:42",
      book: (async () => {
        throw new Error("x");
      }) as never,
      cancel: (async () => {
        throw new Error("x");
      }) as never,
    });
    await expect(silent.booked(NOTICE)).resolves.toBeUndefined();
    await expect(silent.cancel("ap_1")).resolves.toBeUndefined();
  });
});
