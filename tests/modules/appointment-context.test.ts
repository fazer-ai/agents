import { describe, expect, test } from "bun:test";
import {
  type AppointmentJobRow,
  buildAppointmentContextSection,
  parseStartMs,
  projectAppointmentEvents,
} from "@/modules/appointments/context";

// NOW: 2026-08-07T15:00:00Z. All start times below are chosen relative to this instant.
const NOW = new Date("2026-08-07T12:00:00-03:00");
const FUTURE = "2026-08-08T10:00:00-03:00";
const PAST = "2026-08-06T10:00:00-03:00";

function row(over: {
  status?: string;
  updatedAt?: Date;
  payload?: Record<string, unknown>;
}): AppointmentJobRow {
  return {
    status: over.status ?? "PENDING",
    runAt: new Date("2026-08-07T09:00:00-03:00"),
    updatedAt: over.updatedAt ?? new Date("2026-08-05T00:00:00-03:00"),
    payload: {
      threadId: "1:2:3",
      eventId: "ev_1",
      calendarId: "primary",
      credentialRef: "vault:9",
      startISO: FUTURE,
      offsetHours: 24,
      isLast: false,
      askConfirmation: true,
      summary: "Consulta",
      calendarLabel: "Agenda Dra. Ana",
      ...over.payload,
    },
  };
}

describe("projectAppointmentEvents", () => {
  test("a single DONE row with a future start is a live appointment (post-last-reminder turn)", () => {
    const events = projectAppointmentEvents([row({ status: "DONE" })], NOW);
    expect(events).toEqual([
      {
        eventId: "ev_1",
        calendarId: "primary",
        calendarLabel: "Agenda Dra. Ana",
        startISO: FUTURE,
        summary: "Consulta",
      },
    ]);
  });

  test("DONE with a past start is gone; PENDING and CLAIMED are live; DEAD with future start is live", () => {
    expect(
      projectAppointmentEvents(
        [row({ status: "DONE", payload: { startISO: PAST } })],
        NOW,
      ),
    ).toEqual([]);
    for (const status of ["PENDING", "CLAIMED"]) {
      expect(projectAppointmentEvents([row({ status })], NOW)).toHaveLength(1);
    }
    expect(
      projectAppointmentEvents([row({ status: "DEAD" })], NOW),
    ).toHaveLength(1);
  });

  test("a cancelled appointment (every row tombstoned) never resurfaces, even with a future start", () => {
    const events = projectAppointmentEvents(
      [
        row({
          status: "DONE",
          payload: { cancelledAt: "2026-08-07T10:00:00-03:00" },
        }),
        row({
          status: "DONE",
          payload: { offsetHours: 1, cancelledAt: "2026-08-07T10:00:00-03:00" },
        }),
      ],
      NOW,
    );
    expect(events).toEqual([]);
  });

  test("reschedule: tombstoned leftovers are ignored and the freshest payload wins", () => {
    const events = projectAppointmentEvents(
      [
        // Dropped offset from before the reschedule (cancel stamped it).
        row({
          status: "DONE",
          updatedAt: new Date("2026-08-06T00:00:00-03:00"),
          payload: { cancelledAt: "2026-08-06T01:00:00-03:00" },
        }),
        // Re-armed row, authoritative payload (new start + summary).
        row({
          status: "PENDING",
          updatedAt: new Date("2026-08-07T00:00:00-03:00"),
          payload: {
            startISO: "2026-08-09T14:00:00-03:00",
            summary: "Consulta (remarcada)",
          },
        }),
        // Older surviving row of the same event.
        row({
          status: "DONE",
          updatedAt: new Date("2026-08-05T00:00:00-03:00"),
          payload: { offsetHours: 48 },
        }),
      ],
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.startISO).toBe("2026-08-09T14:00:00-03:00");
    expect(events[0]?.summary).toBe("Consulta (remarcada)");
  });

  test("future-ness is decided by the instant, not by string comparison across offsets", () => {
    // "23:00+09:00" on the 7th = 14:00Z, one hour BEFORE now (15:00Z) — lexicographically it
    // looks later than now's local rendering.
    expect(
      projectAppointmentEvents(
        [
          row({
            status: "DONE",
            payload: { startISO: "2026-08-07T23:00:00+09:00" },
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
    // "10:00+09:00" on the 8th = 01:00Z on the 8th — genuinely in the future.
    expect(
      projectAppointmentEvents(
        [
          row({
            status: "DONE",
            payload: { startISO: "2026-08-08T10:00:00+09:00" },
          }),
        ],
        NOW,
      ),
    ).toHaveLength(1);
  });

  test("an unparseable start on a fired row is not future (fail-safe absent)", () => {
    expect(
      projectAppointmentEvents(
        [row({ status: "DONE", payload: { startISO: "not-a-date" } })],
        NOW,
      ),
    ).toEqual([]);
  });

  test("rows without an eventId are dropped; events sort by start ascending", () => {
    const events = projectAppointmentEvents(
      [
        row({ payload: { eventId: undefined } }),
        row({
          payload: { eventId: "ev_b", startISO: "2026-08-09T09:00:00-03:00" },
        }),
        row({
          payload: { eventId: "ev_a", startISO: "2026-08-08T09:00:00-03:00" },
        }),
      ],
      NOW,
    );
    expect(events.map((e) => e.eventId)).toEqual(["ev_a", "ev_b"]);
  });

  test("missing summary/calendarLabel normalize to null (pre-enrichment rows keep working)", () => {
    const events = projectAppointmentEvents(
      [row({ payload: { summary: undefined, calendarLabel: undefined } })],
      NOW,
    );
    expect(events[0]?.summary).toBeNull();
    expect(events[0]?.calendarLabel).toBeNull();
  });
});

describe("buildAppointmentContextSection", () => {
  const event = {
    eventId: "ev_1",
    calendarId: "cal@group.calendar.google.com",
    calendarLabel: "Agenda Dra. Ana",
    startISO: FUTURE,
    summary: "Consulta",
  };

  test("no events → no section", () => {
    expect(buildAppointmentContextSection([], true)).toBeNull();
  });

  test("carries event_id, calendar_id, label, start and summary as XML attributes", () => {
    const s = buildAppointmentContextSection([event], true);
    expect(s).toContain("## Agendamentos deste atendimento (Google Calendar)");
    expect(s).toContain('event_id="ev_1"');
    expect(s).toContain('calendar_id="cal@group.calendar.google.com"');
    expect(s).toContain('calendar="Agenda Dra. Ana"');
    expect(s).toContain(`start="${FUTURE}"`);
    expect(s).toContain('summary="Consulta"');
  });

  test("hostile summary is escaped (block stays well-formed)", () => {
    const s = buildAppointmentContextSection(
      [{ ...event, summary: 'x"/><injected foo="bar' }],
      true,
    );
    expect(s).not.toContain("<injected");
    expect(s).toContain("&lt;injected");
  });

  test("tool affordance only when the calendar write tools are granted", () => {
    const withTools = buildAppointmentContextSection([event], true);
    expect(withTools).toContain("calendar_update_event");
    expect(withTools).toContain("event_id");
    const readOnly = buildAppointmentContextSection([event], false);
    expect(readOnly).not.toContain("calendar_update_event");
  });
});

// NOTE: parseStartMs pins offset-less startISO values to UTC — the same rule the sweep SQL mirrors —
// so the JS and Postgres liveness decisions cannot diverge when app and DB time zones differ.
describe("parseStartMs", () => {
  test("all-day date parses as UTC midnight", () => {
    expect(parseStartMs("2026-06-13")).toBe(Date.parse("2026-06-13T00:00:00Z"));
  });

  test("an offset-less datetime is pinned to UTC (host-TZ independent)", () => {
    expect(parseStartMs("2026-06-13T12:00:00")).toBe(
      Date.parse("2026-06-13T12:00:00Z"),
    );
  });

  test("explicit offsets and Z are honored unchanged", () => {
    expect(parseStartMs("2026-06-13T12:00:00-03:00")).toBe(
      Date.parse("2026-06-13T15:00:00Z"),
    );
    expect(parseStartMs("2026-06-13T12:00:00Z")).toBe(
      Date.parse("2026-06-13T12:00:00Z"),
    );
  });

  test("garbage stays NaN (fail-safe not-future)", () => {
    expect(Number.isNaN(parseStartMs("amanhã de manhã"))).toBe(true);
    expect(Number.isNaN(parseStartMs(""))).toBe(true);
  });

  // NOTE: Date.parse would roll these over (Feb 30 → Mar 2) while the sweep's pg_input_is_valid
  // rejects them — NaN keeps the two liveness decisions in agreement.
  test("impossible calendar dates are NaN, not rolled over", () => {
    expect(Number.isNaN(parseStartMs("2026-02-30"))).toBe(true);
    expect(Number.isNaN(parseStartMs("2026-04-31T12:00:00"))).toBe(true);
    expect(Number.isNaN(parseStartMs("2023-02-29T10:00:00Z"))).toBe(true);
    expect(Number.isNaN(parseStartMs("2024-02-29"))).toBe(false);
    // NOTE: Years below 0100 are valid — the guard must not let Date.UTC remap them to 19xx.
    expect(parseStartMs("0099-02-28")).toBe(Date.parse("0099-02-28T00:00:00Z"));
  });
});
