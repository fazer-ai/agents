import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { googleCalendarToolpack } from "@/modules/integrations/toolpacks/google-calendar";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

// Issue #345: `calendar_create_event` (and `calendar_update_event`) wrote any `start` they were
// handed. `calendar_check_availability` enforces the service hours, the slot grid, the minimum lead
// and the existing bookings; the write path enforced none of them, so a time availability would
// never offer was still bookable and the operator only found out when someone showed up.
//
// The rule these tests pin is ONE sentence: a write only lands on a (start, end) pair that
// `calendar_check_availability` would have returned for that window. Every case below is a way of
// not being on that list.

const TZ = "America/Sao_Paulo";
const WD: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
function spWeekday(isoStr: string): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(new Date(isoStr));
  return WD[s] ?? 0;
}

type Call = { url: string; init: RequestInit };

// A fetch stub that answers per request instead of returning one canned body: the write path now
// READS before it writes, so a single canned response cannot represent both halves.
function routeFetch(
  handler: (
    url: string,
    init: RequestInit,
  ) => { status?: number; json: unknown },
) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    calls.push({ url: u, init: i });
    const r = handler(u, i);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// The requests that actually MUTATE the calendar. The read half of the write path also touches
// /events (blocking calendars are read with events.list), so the method is what separates them.
function writes(calls: Call[]): Call[] {
  return calls.filter(
    (c) =>
      c.url.includes("/events") &&
      (c.init.method === "POST" || c.init.method === "PATCH"),
  );
}

const STAMP = "1:7";
const stampedExt = { private: { secv4Contact: STAMP } };
const noopAssert = async () => undefined;

function baseCtx(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 1n,
    base: undefined as unknown as PrismaClient,
    threadId: "1:1:1",
    contactDbId: 7n,
    resolveCredential: async () => "tok_live",
    assertSafe: noopAssert,
    ...over,
  };
}

function sel(over: Partial<IntegrationSelection> = {}): IntegrationSelection {
  return {
    instanceId: 1n,
    catalogType: "GOOGLE_CALENDAR",
    config: {},
    credentialRef: "gcal-cred",
    enabledTools: [],
    ...over,
  };
}

function toolFor(
  name: string,
  config: Record<string, unknown>,
  ctx: ToolpackCtx,
) {
  return googleCalendarToolpack.build(
    sel({
      enabledTools: [name],
      config: { calendarIds: ["primary"], ...config },
    }),
    ctx,
  )[0];
}

// One-hour appointments offered on the hour: the configuration the issue describes, where a 14:15
// start is a time the business does not sell.
const HOURLY = { slotDurationMinutes: 60, slotGranularityMinutes: 60 };

// Far enough out that the real clock never makes these cases about the lead time.
const DAY = "2099-06-22";
const AT = (hm: string) => `${DAY}T${hm}:00-03:00`;

// freeBusy answers empty, everything else is a successful write.
function freeCalendar(busy: { start: string; end: string }[] = []) {
  return routeFetch((url) =>
    url.includes("/freeBusy")
      ? { json: { calendars: { primary: { busy } } } }
      : { json: { id: "ev_1", start: { dateTime: AT("14:00") } } },
  );
}

describe("calendar writes honor availability (#345)", () => {
  test("a start off the operator's grid is refused, and nothing is written", async () => {
    const { impl, calls } = freeCalendar();
    const out = (await toolFor(
      "calendar_create_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: AT("14:15"),
      end: AT("15:15"),
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("not a bookable");
  });

  test("the refusal names bookable times, so the turn can recover", async () => {
    const { impl } = freeCalendar();
    const out = (await toolFor(
      "calendar_create_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: AT("14:15"),
      end: AT("15:15"),
    })) as string;
    // 14:00 and 15:00 are on the grid and free; the refusal has to offer them.
    expect(out).toContain("14:00");
    expect(out).toContain("15:00");
  });

  test("a start already taken by another booking is refused (no double booking)", async () => {
    const { impl, calls } = freeCalendar([
      { start: AT("14:00"), end: AT("15:00") },
    ]);
    const out = (await toolFor(
      "calendar_create_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: AT("14:00"),
      end: AT("15:00"),
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("not a bookable");
  });

  test("a start outside the service hours is refused", async () => {
    const { impl, calls } = freeCalendar();
    const day = spWeekday(AT("09:00"));
    const out = (await toolFor(
      "calendar_create_event",
      { ...HOURLY, businessHoursId: "5" },
      baseCtx({
        fetchImpl: impl,
        resolveBusinessHours: async () => ({
          windows: [{ day, start: "09:00", end: "12:00" }],
          exceptions: [],
          timezone: TZ,
        }),
      }),
    )?.invoke({
      summary: "Consulta",
      start: AT("14:00"),
      end: AT("15:00"),
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("not a bookable");
  });

  test("a start inside the minimum lead is refused", async () => {
    const { impl, calls } = routeFetch((url) =>
      url.includes("/freeBusy")
        ? { json: { calendars: { primary: { busy: [] } } } }
        : { json: { id: "ev_1" } },
    );
    // The next hour boundary at least 30 minutes out, against a four-hour lead.
    const soon = Math.ceil((Date.now() + 30 * 60_000) / 3_600_000) * 3_600_000;
    const out = (await toolFor(
      "calendar_create_event",
      { ...HOURLY, minLeadMinutes: 240 },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: new Date(soon).toISOString(),
      end: new Date(soon + 3_600_000).toISOString(),
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("not a bookable");
  });

  test("an all-day event is refused: availability never offers one", async () => {
    const { impl, calls } = freeCalendar();
    const out = (await toolFor(
      "calendar_create_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: DAY,
      end: "2099-06-23",
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("start and end time");
  });

  test("an availability read that fails refuses the write instead of writing blind", async () => {
    const { impl, calls } = routeFetch((url) =>
      url.includes("/freeBusy")
        ? { status: 401, json: { error: "nope" } }
        : { json: { id: "ev_1" } },
    );
    const out = (await toolFor(
      "calendar_create_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: AT("14:00"),
      end: AT("15:00"),
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("cannot be verified");
  });

  test("a bookable start still writes (the control: the rule refuses, it does not block)", async () => {
    const { impl, calls } = freeCalendar();
    await toolFor(
      "calendar_create_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: AT("14:00"),
      end: AT("15:00"),
    });
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]?.init.method).toBe("POST");
  });

  test("rescheduling to a time off the grid is refused, and nothing is patched", async () => {
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return { json: { calendars: { primary: { busy: [] } } } };
      if (init.method === "GET")
        return {
          json: {
            id: "ev_1",
            extendedProperties: stampedExt,
            start: { dateTime: AT("14:00") },
            end: { dateTime: AT("15:00") },
          },
        };
      return { json: { id: "ev_1" } };
    });
    const out = (await toolFor(
      "calendar_update_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_1",
      start: AT("16:15"),
      end: AT("17:15"),
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("not a bookable");
  });

  test("rescheduling does not collide with the appointment being moved", async () => {
    // The event's own 14:00-15:00 window comes back in freeBusy. Moving it to 14:00 + one grid step
    // overlaps that window, so a check that forgets to drop it refuses every reschedule.
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return {
          json: {
            calendars: {
              primary: { busy: [{ start: AT("14:00"), end: AT("15:00") }] },
            },
          },
        };
      if (init.method === "GET")
        return {
          json: {
            id: "ev_1",
            extendedProperties: stampedExt,
            start: { dateTime: AT("14:00") },
            end: { dateTime: AT("15:00") },
          },
        };
      return { json: { id: "ev_1" } };
    });
    await toolFor(
      "calendar_update_event",
      // A half-hour grid, so 14:30 IS a start the operator sells: the only thing that could refuse
      // this move is the appointment's own window, which is what the test is about.
      { slotDurationMinutes: 60, slotGranularityMinutes: 30 },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_1",
      start: AT("14:30"),
      end: AT("15:30"),
    });
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]?.init.method).toBe("PATCH");
  });

  test("an edit that does not move the appointment needs no availability read", async () => {
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return { json: { calendars: { primary: { busy: [] } } } };
      if (init.method === "GET")
        return { json: { id: "ev_1", extendedProperties: stampedExt } };
      return { json: { id: "ev_1" } };
    });
    await toolFor(
      "calendar_update_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_1", summary: "Consulta (remarcada)" });
    expect(writes(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/freeBusy"))).toHaveLength(0);
  });
});
