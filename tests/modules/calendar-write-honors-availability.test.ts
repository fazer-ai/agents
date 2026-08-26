import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { zonedWallClock } from "@/modules/integrations/toolpacks/calendar-slots";
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

// The three defects round 1 of the review found, each as the case that separates the two behaviours.
describe("calendar writes honor availability — round 1 (#345)", () => {
  function tzWeekday(isoStr: string, tz: string): number {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
    }).format(new Date(isoStr));
    return WD[s] ?? 0;
  }

  test("a start with no offset is read in the calendar's timezone, not the server's", async () => {
    // Google resolves an offset-less `dateTime` with the event's own timeZone, so the rule has to
    // resolve it the same way. Date.parse would read it in the SERVER's zone: 10:00 judged as 22:00
    // in Tokyo (from a -03:00 runner) or 19:00 (from a UTC one), both outside the service hours.
    const TOKYO = "Asia/Tokyo";
    const day = tzWeekday("2099-06-22T10:00:00+09:00", TOKYO);
    const { impl, calls } = routeFetch((url) =>
      url.includes("/freeBusy")
        ? { json: { calendars: { primary: { busy: [] } } } }
        : { json: { id: "ev_tz" } },
    );
    const out = (await toolFor(
      "calendar_create_event",
      { ...HOURLY, timeZone: TOKYO, businessHoursId: "5" },
      baseCtx({
        fetchImpl: impl,
        resolveBusinessHours: async () => ({
          windows: [{ day, start: "09:00", end: "18:00" }],
          exceptions: [],
          timezone: TOKYO,
        }),
      }),
    )?.invoke({
      summary: "Consulta",
      start: "2099-06-22T10:00:00",
      end: "2099-06-22T11:00:00",
    })) as string;
    expect(out).not.toContain("not a bookable");
    expect(writes(calls)).toHaveLength(1);
  });

  test("an operator closure is not punched through by the appointment being moved", async () => {
    // The appointment moves; the closure does not. Subtracting the event's span from the ASSEMBLED
    // busy list took an hour out of a blocking calendar's event, and the reschedule landed inside a
    // closure the operator had declared.
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return {
          json: {
            calendars: {
              primary: { busy: [{ start: AT("14:00"), end: AT("15:00") }] },
            },
          },
        };
      if (url.includes("holidays") && init.method === "GET")
        return {
          json: {
            items: [
              {
                start: { dateTime: AT("13:00") },
                end: { dateTime: AT("16:00") },
              },
            ],
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
    const out = (await toolFor(
      "calendar_update_event",
      {
        slotDurationMinutes: 30,
        slotGranularityMinutes: 30,
        blockingCalendarIds: ["holidays@demo"],
      },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_1",
      start: AT("14:00"),
      end: AT("14:30"),
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("not a bookable");
  });

  test("a legacy all-day appointment can still be converted to a timed slot on its own day", async () => {
    // freeBusy reports the all-day event as a day-long busy interval. Read from the request, its
    // span is unrepresentable (a bare date is not an instant), so it stayed in the busy list and
    // every same-day conversion collided with the very event being converted.
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return {
          json: {
            calendars: {
              primary: {
                busy: [
                  {
                    start: `${DAY}T00:00:00-03:00`,
                    end: "2099-06-23T00:00:00-03:00",
                  },
                ],
              },
            },
          },
        };
      if (init.method === "GET")
        return {
          json: {
            id: "ev_legacy",
            extendedProperties: stampedExt,
            start: { date: DAY },
            end: { date: "2099-06-23" },
          },
        };
      return { json: { id: "ev_legacy" } };
    });
    await toolFor(
      "calendar_update_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_legacy",
      start: AT("14:00"),
      end: AT("15:00"),
    });
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]?.init.method).toBe("PATCH");
  });

  test("the refusal carries each alternative's exact instants, not only its label", async () => {
    // The label has no year and no offset, and across a DST fallback two distinct slots wear the
    // same one. The tool refuses to guess a timestamp, so it cannot ask the model to build one.
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
    expect(out).toContain(new Date(Date.parse(AT("14:00"))).toISOString());
    expect(out).toContain(new Date(Date.parse(AT("15:00"))).toISOString());
  });

  test("resending the same times while renaming is not a move, and is not checked", async () => {
    // The appointment is in the past, so judging it would refuse. The tool promises an edit that
    // leaves the time alone is never checked, and a caller that echoes back the times it already
    // has is doing exactly that.
    const PAST_START = "2020-06-22T14:00:00-03:00";
    const PAST_END = "2020-06-22T15:00:00-03:00";
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return { json: { calendars: { primary: { busy: [] } } } };
      if (init.method === "GET")
        return {
          json: {
            id: "ev_1",
            extendedProperties: stampedExt,
            start: { dateTime: PAST_START },
            end: { dateTime: PAST_END },
          },
        };
      return { json: { id: "ev_1" } };
    });
    await toolFor(
      "calendar_update_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_1",
      summary: "Consulta (nome novo)",
      start: PAST_START,
      end: PAST_END,
    });
    expect(writes(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/freeBusy"))).toHaveLength(0);
  });
});

// Round 2 and 3 of the review: three ways the boundary between the string the model sends and the
// instant the rule judges leaked.
describe("calendar writes honor availability — round 3 (#345)", () => {
  test("unchanged all-day values are left out of the patch, not reshaped", async () => {
    // The timed patch shape would reach Google as a `dateTime` of "2099-06-22" with `date` cleared,
    // and be rejected — an edit that changes nothing about the time breaking the rename it carried.
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return { json: { calendars: { primary: { busy: [] } } } };
      if (init.method === "GET")
        return {
          json: {
            id: "ev_legacy",
            extendedProperties: stampedExt,
            start: { date: DAY },
            end: { date: "2099-06-23" },
          },
        };
      return { json: { id: "ev_legacy" } };
    });
    await toolFor(
      "calendar_update_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_legacy",
      summary: "Feriado (nome novo)",
      start: DAY,
      end: "2099-06-23",
    });
    const patch = writes(calls)[0];
    expect(patch).toBeDefined();
    const body = JSON.parse(String(patch?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.summary).toBe("Feriado (nome novo)");
    expect(body.start).toBeUndefined();
    expect(body.end).toBeUndefined();
  });

  test("a runaway end does not widen the range the availability read asks Google for", async () => {
    // `end` is a model argument and nothing bounds it. Widening the window by the requested span
    // would turn one day of freeBusy into centuries before anything got the chance to refuse it.
    const { impl, calls } = freeCalendar();
    const out = (await toolFor(
      "calendar_create_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: AT("14:00"),
      end: "2200-06-22T15:00:00-03:00",
    })) as string;
    const freeBusy = calls.find((c) => c.url.includes("/freeBusy"));
    const range = JSON.parse(String(freeBusy?.init.body)) as {
      timeMin: string;
      timeMax: string;
    };
    expect(Date.parse(range.timeMax) - Date.parse(range.timeMin)).toBeLessThan(
      36 * 3_600_000,
    );
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("not a bookable");
  });

  test("a wall clock the timezone skips is refused before any request", async () => {
    // 02:30 does not exist on the day New York jumps 02:00 to 03:00. Resolving it anyway lands on a
    // different instant than the string Google receives, which is the divergence being removed.
    const { impl, calls } = freeCalendar();
    const out = (await toolFor(
      "calendar_create_event",
      { ...HOURLY, timeZone: "America/New_York" },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: "2026-03-08T02:30:00",
      end: "2026-03-08T03:30:00",
    })) as string;
    expect(calls).toHaveLength(0);
    expect(out).toContain("ISO 8601 timestamps with an offset");
  });

  test("a wall clock the timezone keeps is still accepted", () => {
    // The control: the refusal above has to be about the skipped hour, not about offset-less input.
    expect(zonedWallClock("2026-03-08T04:30:00", "America/New_York")).toEqual({
      ms: Date.parse("2026-03-08T04:30:00-04:00"),
      exists: true,
    });
    expect(
      zonedWallClock("2026-03-08T02:30:00", "America/New_York").exists,
    ).toBe(false);
  });
});

describe("calendar writes honor availability — round 4 (#345)", () => {
  test("changing a legacy all-day date reaches the refusal instead of being dropped", async () => {
    // Both bare dates resolve to no instant, so comparing instants alone made every all-day value
    // equal to every other: the move was classified as "nothing changed" and silently discarded.
    const { impl, calls } = routeFetch((url, init) => {
      if (url.includes("/freeBusy"))
        return { json: { calendars: { primary: { busy: [] } } } };
      if (init.method === "GET")
        return {
          json: {
            id: "ev_legacy",
            extendedProperties: stampedExt,
            start: { date: DAY },
            end: { date: "2099-06-23" },
          },
        };
      return { json: { id: "ev_legacy" } };
    });
    const out = (await toolFor(
      "calendar_update_event",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_legacy",
      start: "2099-06-23",
      end: "2099-06-24",
    })) as string;
    expect(writes(calls)).toHaveLength(0);
    expect(out).toContain("start and end time");
  });
});
