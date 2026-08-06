import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { googleCalendarToolpack } from "@/modules/integrations/toolpacks/google-calendar";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

// A fetch stub that records the request and returns a canned JSON response (same for every call).
function stubFetch(status: number, json: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noopAssert = async () => undefined;

// América/Sao_Paulo is a fixed UTC-3 (no DST since 2019). Helpers to assert on slot wall-times.
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
function localHM(isoStr: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoStr));
}

// Default ctx carries a contact (Contact.id 7n, tenant 1n) → stamp "1:7". The per-contact tools fail
// closed without it; pass contactDbId: null to exercise that path.
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

const STAMP = "1:7";
const stampedExt = { private: { secv4Contact: STAMP } };

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

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

// Default the fixture to a single configured calendar ("primary") so tests that don't care about
// calendar selection still exercise the tool logic. calendarIds is fail-closed in prod (empty → no
// calendar, tools refuse), so pass calendarIds explicitly (e.g. []) to test the selection/refusal path.
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

describe("google calendar toolpack — allowlist (fail-closed)", () => {
  test("empty allowlist → no tools", () => {
    expect(
      googleCalendarToolpack.build(sel({ enabledTools: [] }), baseCtx()),
    ).toEqual([]);
  });
  test("only allowlisted tools are exposed", () => {
    const tools = googleCalendarToolpack.build(
      sel({ enabledTools: ["calendar_list_events"] }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name)).toEqual(["calendar_list_events"]);
  });
  test("all six when granted", () => {
    const tools = googleCalendarToolpack.build(
      sel({
        enabledTools: [
          "calendar_list_events",
          "calendar_check_availability",
          "calendar_create_event",
          "calendar_update_event",
          "calendar_cancel_event",
          "calendar_confirm_appointment",
        ],
      }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      "calendar_cancel_event",
      "calendar_check_availability",
      "calendar_confirm_appointment",
      "calendar_create_event",
      "calendar_list_events",
      "calendar_update_event",
    ]);
  });
  test("an unknown tool name yields nothing", () => {
    expect(
      googleCalendarToolpack.build(sel({ enabledTools: ["bogus"] }), baseCtx()),
    ).toEqual([]);
  });
});

describe("google calendar toolpack — credential + calendar binding", () => {
  test("the bearer token flows only into the Authorization header, never the return", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    const tool = toolFor(
      "calendar_list_events",
      {},
      baseCtx({ fetchImpl: impl, resolveCredential: async () => "SECRET_TOK" }),
    );
    const out = (await tool?.invoke({})) as string;
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer SECRET_TOK");
    expect(out).not.toContain("SECRET_TOK");
  });

  test("missing credential → friendly error, no fetch", async () => {
    const { impl, calls } = stubFetch(200, {});
    const tool = googleCalendarToolpack.build(
      sel({ enabledTools: ["calendar_list_events"], credentialRef: null }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({})) as string;
    expect(out.toLowerCase()).toContain("not connected");
    expect(calls).toHaveLength(0);
  });

  test("no calendar configured → fail-closed refusal, no fetch", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    const out = (await toolFor(
      "calendar_list_events",
      { calendarIds: [] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({})) as string;
    expect(out).toContain("No calendar is configured");
    expect(calls).toHaveLength(0);
  });

  test("a single allowed calendar is auto-selected", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    await toolFor(
      "calendar_list_events",
      { calendarIds: ["team@group.calendar.google.com"] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({});
    expect(calls[0]?.url).toContain(
      `/calendars/${encodeURIComponent("team@group.calendar.google.com")}/events`,
    );
  });

  test("several allowed calendars + no arg → asks to choose, no fetch", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    const out = (await toolFor(
      "calendar_list_events",
      { calendarIds: ["a@g.com", "b@g.com"] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({})) as string;
    expect(out).toContain("Multiple calendars");
    expect(calls).toHaveLength(0);
  });

  test("a calendarId arg within the allowlist is used", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    await toolFor(
      "calendar_list_events",
      { calendarIds: ["a@g.com", "b@g.com"] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ calendarId: "b@g.com" });
    expect(calls[0]?.url).toContain(
      `/calendars/${encodeURIComponent("b@g.com")}/events`,
    );
  });

  test("a calendarId arg outside the allowlist is rejected, no fetch (injection boundary)", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    const out = (await toolFor(
      "calendar_list_events",
      { calendarIds: ["a@g.com"] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ calendarId: "evil@g.com" })) as string;
    expect(out).toContain("not allowed");
    expect(calls).toHaveLength(0);
  });

  test("a friendly calendar name (label) resolves to its id", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    await toolFor(
      "calendar_list_events",
      {
        calendarIds: ["a@g.com", "b@g.com"],
        calendarLabels: { "a@g.com": "Dr. Ana" },
      },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ calendarId: "dr. ana" });
    expect(calls[0]?.url).toContain(
      `/calendars/${encodeURIComponent("a@g.com")}/events`,
    );
  });
});

describe("google calendar toolpack — per-contact isolation", () => {
  test("list fences the query to THIS contact's events (privateExtendedProperty), no free-text q", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    await toolFor(
      "calendar_list_events",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({});
    const u = new URL(calls[0]?.url as string);
    expect(u.searchParams.get("privateExtendedProperty")).toBe(
      `secv4Contact=${STAMP}`,
    );
    expect(u.searchParams.get("q")).toBeNull();
  });

  test("list re-verifies each event's stamp client-side: a foreign event is dropped", async () => {
    const { impl } = stubFetch(200, {
      items: [
        {
          id: "mine",
          summary: "Mine",
          start: { dateTime: "2026-06-20T10:00:00-03:00" },
          extendedProperties: stampedExt,
        },
        {
          id: "theirs",
          summary: "Theirs",
          start: { dateTime: "2026-06-20T11:00:00-03:00" },
          extendedProperties: { private: { secv4Contact: "1:99" } },
        },
        { id: "untagged", summary: "Staff event" },
      ],
    });
    const out = (await toolFor(
      "calendar_list_events",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({})) as string;
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed.map((e) => e.id)).toEqual(["mine"]);
  });

  test("list with no contact in scope → fails closed, no fetch", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    const out = (await toolFor(
      "calendar_list_events",
      {},
      baseCtx({ fetchImpl: impl, contactDbId: null }),
    )?.invoke({})) as string;
    expect(out).toBe(
      "This calendar action is only available inside a customer conversation (each customer only ever sees their own appointments). There is no contact in scope right now.",
    );
    expect(calls).toHaveLength(0);
  });

  test("create stamps the event with the contact and never sends attendees", async () => {
    const { impl, calls } = stubFetch(200, { id: "ev_1" });
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: "2026-06-20T14:00:00-03:00",
      end: "2026-06-20T15:00:00-03:00",
      // attendees is no longer in the schema; even if passed, it must never reach Google.
      attendees: ["lead@example.com"],
    });
    const body = bodyOf(calls[0] as { init: RequestInit });
    expect(body.extendedProperties).toEqual(stampedExt);
    expect(body.attendees).toBeUndefined();
  });

  test("create with no contact in scope → fails closed, no fetch", async () => {
    const { impl, calls } = stubFetch(200, { id: "ev_1" });
    const out = (await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl, contactDbId: null }),
    )?.invoke({
      summary: "x",
      start: "2026-06-20",
      end: "2026-06-21",
    })) as string;
    expect(out).toContain("only available inside a customer conversation");
    expect(calls).toHaveLength(0);
  });

  test("update refuses an event that is not this contact's (ownership gate), no PATCH", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_x",
      extendedProperties: { private: { secv4Contact: "1:99" } },
    });
    const out = (await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_x", summary: "Hijack" })) as string;
    expect(out).toContain("not associated with this customer");
    // Only the ownership GET happened; no PATCH.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("update refuses an untagged (staff-created) event", async () => {
    const { impl, calls } = stubFetch(200, { id: "ev_x" });
    const out = (await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_x", summary: "Hijack" })) as string;
    expect(out).toContain("not associated with this customer");
    expect(calls).toHaveLength(1);
  });

  test("update proceeds for this contact's own event", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_3",
      summary: "Renamed",
      extendedProperties: stampedExt,
    });
    await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_3", summary: "Renamed" });
    // calls[0] = ownership GET, calls[1] = the PATCH.
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[1]?.init.method).toBe("PATCH");
    expect(calls[1]?.url).toContain("/events/ev_3");
    expect(bodyOf(calls[1] as { init: RequestInit })).toEqual({
      summary: "Renamed",
    });
  });

  test("update with no fields → message before any fetch", async () => {
    const { impl, calls } = stubFetch(200, {});
    const out = (await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_3" })) as string;
    expect(out.toLowerCase()).toContain("at least one");
    expect(calls).toHaveLength(0);
  });

  test("cancel deletes this contact's own event (ownership GET then DELETE)", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_9",
      extendedProperties: stampedExt,
    });
    const out = (await toolFor(
      "calendar_cancel_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_9" })) as string;
    expect(out.toLowerCase()).toContain("cancelled");
    // calls[0] = ownership GET, calls[1] = the DELETE.
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[1]?.url).toContain("/events/ev_9");
  });

  test("cancel refuses an event that is not this contact's (no DELETE)", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_x",
      extendedProperties: { private: { secv4Contact: "1:99" } },
    });
    const out = (await toolFor(
      "calendar_cancel_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_x" })) as string;
    expect(out).toContain("not associated with this customer");
    // Only the ownership GET happened; no DELETE.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("cancel with no contact in scope → fails closed, no fetch", async () => {
    const { impl, calls } = stubFetch(204, {});
    const out = (await toolFor(
      "calendar_cancel_event",
      {},
      baseCtx({ fetchImpl: impl, contactDbId: null }),
    )?.invoke({ eventId: "ev_x" })) as string;
    expect(out).toContain("only available inside a customer conversation");
    expect(calls).toHaveLength(0);
  });
});

describe("google calendar toolpack — appointment reminders + confirmation", () => {
  test("create arms reminders via ctx (eventId + calendarId + startISO)", async () => {
    const { impl } = stubFetch(200, {
      id: "ev_1",
      start: { dateTime: "2026-06-25T10:00:00-03:00" },
    });
    const scheduled: Array<{
      eventId: string;
      calendarId: string;
      startISO: string;
      credentialRef: string | null;
      offsetsHours: number[];
      askConfirmationOnLast: boolean;
    }> = [];
    await toolFor(
      "calendar_create_event",
      {
        appointmentReminders: {
          enabled: true,
          offsetsHours: [24, 1],
          askConfirmationOnLast: true,
        },
      },
      baseCtx({
        fetchImpl: impl,
        scheduleAppointmentReminders: async (a) => {
          scheduled.push(a);
        },
      }),
    )?.invoke({
      summary: "Consulta",
      start: "2026-06-25T10:00:00-03:00",
      end: "2026-06-25T11:00:00-03:00",
    });
    expect(scheduled).toHaveLength(1);
    // The policy (offsets + confirmation) flows from the integration config, not the agent.
    expect(scheduled[0]).toMatchObject({
      eventId: "ev_1",
      calendarId: "primary",
      startISO: "2026-06-25T10:00:00-03:00",
      offsetsHours: [24, 1],
      askConfirmationOnLast: true,
    });
  });

  test("create does NOT arm reminders when the integration has them disabled", async () => {
    const { impl } = stubFetch(200, {
      id: "ev_2",
      start: { dateTime: "2026-06-25T10:00:00-03:00" },
    });
    let armed = false;
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({
        fetchImpl: impl,
        scheduleAppointmentReminders: async () => {
          armed = true;
        },
      }),
    )?.invoke({
      summary: "Consulta",
      start: "2026-06-25T10:00:00-03:00",
      end: "2026-06-25T11:00:00-03:00",
    });
    expect(armed).toBe(false);
  });

  test("cancel drops reminders via ctx", async () => {
    const { impl } = stubFetch(200, {
      id: "ev_9",
      extendedProperties: stampedExt,
    });
    const cancelled: string[] = [];
    await toolFor(
      "calendar_cancel_event",
      {},
      baseCtx({
        fetchImpl: impl,
        cancelAppointmentReminders: async (id) => {
          cancelled.push(id);
        },
      }),
    )?.invoke({ eventId: "ev_9" });
    expect(cancelled).toEqual(["ev_9"]);
  });

  test("confirm marks [CONFIRMADO] + records secv4Confirmed, keeps the contact stamp", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_3",
      summary: "Consulta",
      extendedProperties: stampedExt,
    });
    const out = (await toolFor(
      "calendar_confirm_appointment",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_3" })) as string;
    expect(out.toLowerCase()).toContain("confirmed");
    // calls[0] = ownership GET, calls[1] = the PATCH.
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[1]?.init.method).toBe("PATCH");
    const body = bodyOf(calls[1] as { init: RequestInit });
    expect(body.summary).toBe("[CONFIRMADO] Consulta");
    const ext = body.extendedProperties as { private: Record<string, unknown> };
    expect(typeof ext.private.secv4Confirmed).toBe("string");
    expect(ext.private.secv4Contact).toBe(STAMP);
  });

  test("confirm is idempotent on the title prefix", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_3",
      summary: "[CONFIRMADO] Consulta",
      extendedProperties: stampedExt,
    });
    await toolFor(
      "calendar_confirm_appointment",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_3" });
    const body = bodyOf(calls[1] as { init: RequestInit });
    expect(body.summary).toBe("[CONFIRMADO] Consulta");
  });

  test("confirm refuses another contact's event (no PATCH)", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_x",
      summary: "X",
      extendedProperties: { private: { secv4Contact: "1:99" } },
    });
    const out = (await toolFor(
      "calendar_confirm_appointment",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ eventId: "ev_x" })) as string;
    expect(out).toContain("not associated with this customer");
    expect(calls).toHaveLength(1);
  });
});

describe("google calendar toolpack — event date shaping + default timezone", () => {
  test("create: a timed start/end becomes dateTime + the config timeZone", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_1",
      summary: "Call",
      start: { dateTime: "2026-06-20T14:00:00-03:00" },
      end: { dateTime: "2026-06-20T15:00:00-03:00" },
      htmlLink: "https://cal/ev_1",
    });
    const out = (await toolFor(
      "calendar_create_event",
      { timeZone: "America/Bahia" },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Call",
      start: "2026-06-20T14:00:00-03:00",
      end: "2026-06-20T15:00:00-03:00",
    })) as string;
    const body = bodyOf(calls[0] as { init: RequestInit });
    expect(body.start).toEqual({
      dateTime: "2026-06-20T14:00:00-03:00",
      timeZone: "America/Bahia",
    });
    expect(JSON.parse(out)).toMatchObject({
      id: "ev_1",
      start: "2026-06-20T14:00:00-03:00",
      htmlLink: "https://cal/ev_1",
    });
  });

  test("create: a bare date is an all-day event (date, no timeZone)", async () => {
    const { impl, calls } = stubFetch(200, { id: "ev_2" });
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Holiday",
      start: "2026-06-20",
      end: "2026-06-21",
    });
    const body = bodyOf(calls[0] as { init: RequestInit });
    expect(body.start).toEqual({ date: "2026-06-20" });
    expect(body.end).toEqual({ date: "2026-06-21" });
  });

  test("create: with no configured timeZone, timed events anchor to São Paulo", async () => {
    const { impl, calls } = stubFetch(200, { id: "ev_4" });
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Call",
      start: "2026-06-20T14:00:00",
      end: "2026-06-20T15:00:00",
    });
    const body = bodyOf(calls[0] as { init: RequestInit });
    expect(body.start).toEqual({
      dateTime: "2026-06-20T14:00:00",
      timeZone: "America/Sao_Paulo",
    });
  });

  // A patch that sets only dateTime leaves the all-day `date` on the event, and Google rejects an
  // event carrying both (HTTP 400). Both directions must null the field they replace.
  test("update: all-day → timed nulls the date field", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_5",
      extendedProperties: stampedExt,
      start: { dateTime: "2026-06-20T00:00:00-03:00" },
      end: { dateTime: "2026-06-20T23:59:00-03:00" },
    });
    await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_5",
      start: "2026-06-20T00:00:00-03:00",
      end: "2026-06-20T23:59:00-03:00",
    });
    // calls[0] is the ownership re-fetch; calls[1] is the PATCH.
    const body = bodyOf(calls[1] as { init: RequestInit });
    expect(body.start).toEqual({
      dateTime: "2026-06-20T00:00:00-03:00",
      timeZone: "America/Sao_Paulo",
      date: null,
    });
    expect(body.end).toEqual({
      dateTime: "2026-06-20T23:59:00-03:00",
      timeZone: "America/Sao_Paulo",
      date: null,
    });
  });

  test("update: timed → all-day nulls the dateTime field", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "ev_6",
      extendedProperties: stampedExt,
      start: { date: "2026-06-20" },
      end: { date: "2026-06-21" },
    });
    await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_6",
      start: "2026-06-20",
      end: "2026-06-21",
    });
    const body = bodyOf(calls[1] as { init: RequestInit });
    expect(body.start).toEqual({ date: "2026-06-20", dateTime: null });
    expect(body.end).toEqual({ date: "2026-06-21", dateTime: null });
  });
});

describe("google calendar toolpack — list + availability", () => {
  test("list clamps maxResults and projects id/summary/start/end", async () => {
    const { impl, calls } = stubFetch(200, {
      items: [
        {
          id: "a",
          summary: "One",
          start: { dateTime: "2026-06-20T10:00:00-03:00" },
          end: { dateTime: "2026-06-20T11:00:00-03:00" },
          extra: "dropped",
          extendedProperties: stampedExt,
        },
        {
          id: "b",
          summary: "All day",
          start: { date: "2026-06-21" },
          extendedProperties: stampedExt,
        },
      ],
    });
    const out = (await toolFor(
      "calendar_list_events",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ maxResults: 999 })) as string;
    expect(calls[0]?.url).toContain("maxResults=25");
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([
      {
        id: "a",
        summary: "One",
        start: "2026-06-20T10:00:00-03:00",
        end: "2026-06-20T11:00:00-03:00",
        htmlLink: undefined,
      },
      {
        id: "b",
        summary: "All day",
        start: "2026-06-21",
        end: null,
        htmlLink: undefined,
      },
    ]);
  });

  test("check_availability posts a freeBusy query and defaults the timeZone to São Paulo", async () => {
    const { impl, calls } = stubFetch(200, {
      calendars: { primary: { busy: [] } },
    });
    await toolFor(
      "calendar_check_availability",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
    });
    expect(calls[0]?.url).toContain("/freeBusy");
    expect(bodyOf(calls[0] as { init: RequestInit })).toMatchObject({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
      timeZone: "America/Sao_Paulo",
      items: [{ id: "primary" }],
    });
  });

  test("availability returns bookable SLOTS honoring business hours, duration, granularity and busy", async () => {
    const day = spWeekday("2099-06-22T09:00:00-03:00");
    const busy = [
      { start: "2099-06-22T10:00:00-03:00", end: "2099-06-22T11:00:00-03:00" },
    ];
    const { impl } = stubFetch(200, { calendars: { primary: { busy } } });
    const out = (await toolFor(
      "calendar_check_availability",
      {
        businessHoursId: "5",
        slotDurationMinutes: 60,
        slotGranularityMinutes: 60,
      },
      baseCtx({
        fetchImpl: impl,
        // Morning-only service hours, in the schedule's own timezone.
        resolveBusinessHours: async () => ({
          windows: [{ day, start: "09:00", end: "12:00" }],
          timezone: TZ,
        }),
      }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
    })) as string;
    const parsed = JSON.parse(out) as {
      slots: { start: string; end: string; label: string }[];
      timeZone: string;
    };
    // 09:00 free, 10:00 busy (dropped), 11:00 free; afternoon is outside the service hours.
    expect(parsed.slots.map((s) => localHM(s.start))).toEqual([
      "09:00",
      "11:00",
    ]);
    expect(parsed.timeZone).toBe(TZ);
    expect(parsed.slots[0]?.label).toContain("09:00");
  });

  test("availability with no schedule configured ⇒ no time-of-day filter (full grid)", async () => {
    const { impl } = stubFetch(200, { calendars: { primary: { busy: [] } } });
    const out = (await toolFor(
      "calendar_check_availability",
      { slotDurationMinutes: 60, slotGranularityMinutes: 60 },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      timeMin: "2099-06-22T09:00:00-03:00",
      timeMax: "2099-06-22T12:00:00-03:00",
    })) as string;
    const parsed = JSON.parse(out) as { slots: { start: string }[] };
    expect(parsed.slots.map((s) => localHM(s.start))).toEqual([
      "09:00",
      "10:00",
      "11:00",
    ]);
  });

  test("availability refuses a range longer than 24h, no fetch", async () => {
    const { impl, calls } = stubFetch(200, {
      calendars: { primary: { busy: [] } },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-24T00:00:00-03:00",
    })) as string;
    expect(out.toLowerCase()).toContain("at most 24 hours");
    expect(calls).toHaveLength(0);
  });

  test("a non-2xx response surfaces the HTTP status (no token leak)", async () => {
    const { impl } = stubFetch(403, { error: "forbidden" });
    const out = (await toolFor(
      "calendar_list_events",
      {},
      baseCtx({ fetchImpl: impl, resolveCredential: async () => "SECRET_TOK" }),
    )?.invoke({})) as string;
    expect(out).toContain("403");
    expect(out).not.toContain("SECRET_TOK");
  });
});

// A fetch stub that routes by URL substring (freeBusy vs each blocking calendar's events.list).
function routedFetch(
  routes: Array<{ match: string; status?: number; json: unknown }>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = routes.find((x) => u.includes(x.match));
    if (!r) throw new Error(`routedFetch: unrouted request ${u}`);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("google calendar toolpack — blocking calendars (issue #1)", () => {
  const BLOQ = "bloqueios@group.calendar.google.com";
  const RANGE = {
    timeMin: "2099-06-22T09:00:00-03:00",
    timeMax: "2099-06-22T12:00:00-03:00",
  };
  const HOURLY = {
    slotDurationMinutes: 60,
    slotGranularityMinutes: 60,
    blockingCalendarIds: [BLOQ],
  };
  const FREE = { calendars: { primary: { busy: [] } } };

  test("reads each blocking calendar via events.list (no contact fence, no titles requested)", async () => {
    const { impl, calls } = routedFetch([
      { match: "/freeBusy", json: FREE },
      { match: "bloqueios%40group", json: { items: [] } },
    ]);
    const out = (await toolFor(
      "calendar_check_availability",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(JSON.parse(out).slots).toHaveLength(3);
    expect(calls).toHaveLength(2);
    const evUrl = calls[1]?.url ?? "";
    expect(evUrl).toContain(
      "/calendars/bloqueios%40group.calendar.google.com/events",
    );
    expect(evUrl).toContain("singleEvents=true");
    expect(evUrl).toContain("fields=items%28start%2Cend%29%2CnextPageToken");
    expect(evUrl).not.toContain("privateExtendedProperty");
  });

  test("fail-closed: a truncated blocking page (nextPageToken) refuses instead of trusting partial data", async () => {
    const { impl } = routedFetch([
      { match: "/freeBusy", json: FREE },
      {
        match: "bloqueios%40group",
        json: { items: [], nextPageToken: "tok_more" },
      },
    ]);
    const out = (await toolFor(
      "calendar_check_availability",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(out).toContain("cannot be verified");
    expect(out).not.toContain("slots");
  });

  test("a timed blocking event drops the overlapping slot", async () => {
    const { impl } = routedFetch([
      { match: "/freeBusy", json: FREE },
      {
        match: "bloqueios%40group",
        json: {
          items: [
            {
              start: { dateTime: "2099-06-22T10:00:00-03:00" },
              end: { dateTime: "2099-06-22T11:00:00-03:00" },
            },
          ],
        },
      },
    ]);
    const out = (await toolFor(
      "calendar_check_availability",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const parsed = JSON.parse(out) as { slots: { start: string }[] };
    expect(parsed.slots.map((s) => localHM(s.start))).toEqual([
      "09:00",
      "11:00",
    ]);
  });

  test("an all-day event blocks the whole local day, even marked transparent (the freeBusy blind spot)", async () => {
    // All-day events default to transparency "transparent" ("Free"), which freeBusy ignores; the
    // holiday calendar from the issue is exactly this shape, so blocking reads events.list instead.
    const { impl } = routedFetch([
      { match: "/freeBusy", json: FREE },
      {
        match: "bloqueios%40group",
        json: {
          items: [
            {
              start: { date: "2099-06-22" },
              end: { date: "2099-06-23" },
              transparency: "transparent",
            },
          ],
        },
      },
    ]);
    const out = (await toolFor(
      "calendar_check_availability",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(JSON.parse(out).slots).toEqual([]);
  });

  test("fail-closed: an unreadable blocking calendar refuses instead of offering slots", async () => {
    const { impl } = routedFetch([
      { match: "/freeBusy", json: FREE },
      { match: "bloqueios%40group", status: 404, json: { error: "notFound" } },
    ]);
    const out = (await toolFor(
      "calendar_check_availability",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(out).toContain("blocking calendar");
    expect(out).toContain("404");
    expect(out).not.toContain("slots");
  });

  test("a blocking id that equals the active booking calendar is ignored (no extra request)", async () => {
    const { impl, calls } = routedFetch([{ match: "/freeBusy", json: FREE }]);
    const out = (await toolFor(
      "calendar_check_availability",
      { ...HOURLY, blockingCalendarIds: ["primary"] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(JSON.parse(out).slots).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  test("fail-closed: a network failure reading a blocking calendar refuses", async () => {
    const impl = (async (url: string | URL | Request) => {
      if (String(url).includes("bloqueios%40group")) {
        throw new Error("network down");
      }
      return new Response(JSON.stringify(FREE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = (await toolFor(
      "calendar_check_availability",
      HOURLY,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(out).toContain("Failed to read a blocking calendar");
    expect(out).not.toContain("slots");
  });

  test("fail-closed: more blocking calendars than the cap refuses without fanning out", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `b${i}@demo.local`);
    const { impl, calls } = routedFetch([{ match: "/freeBusy", json: FREE }]);
    const out = (await toolFor(
      "calendar_check_availability",
      { ...HOURLY, blockingCalendarIds: many },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(out).toContain("Too many blocking calendars");
    expect(calls).toHaveLength(1);
  });

  test("list_events description warns that blocked/foreign events are never visible", () => {
    const tool = toolFor("calendar_list_events", {}, baseCtx());
    expect(tool?.description).toContain("does NOT mean the calendar is free");
    expect(tool?.description).toContain("calendar_check_availability");
  });
});

// NOTE: a booked "call" must hand the customer a real meeting room: without conferenceData the model only
// ever gets htmlLink, the calendar PAGE of the event. Two API traps pinned here: the Google API
// honors conferenceData only when the request carries conferenceDataVersion=1 (silently ignored
// otherwise), and createRequest.requestId must be unique per event (a reused id returns the SAME
// room, so different leads would share a meeting).
describe("google calendar toolpack — Meet room on create", () => {
  const CREATED = {
    id: "ev9",
    summary: "Demo",
    start: { dateTime: "2026-08-10T14:00:00-03:00" },
    end: { dateTime: "2026-08-10T15:00:00-03:00" },
    htmlLink: "https://cal/ev9",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  };
  const INPUT = {
    summary: "Demo",
    start: "2026-08-10T14:00:00-03:00",
    end: "2026-08-10T15:00:00-03:00",
  };

  test("create asks Google for a Meet room by default (body + conferenceDataVersion=1)", async () => {
    const { impl, calls } = stubFetch(200, CREATED);
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke(INPUT);
    expect(calls[0]?.url).toContain("conferenceDataVersion=1");
    const body = bodyOf(calls[0] as { init: RequestInit });
    const conf = body.conferenceData as {
      createRequest?: {
        requestId?: string;
        conferenceSolutionKey?: { type?: string };
      };
    };
    expect(conf?.createRequest?.conferenceSolutionKey?.type).toBe(
      "hangoutsMeet",
    );
    expect(typeof conf?.createRequest?.requestId).toBe("string");
  });

  test("each create uses a fresh requestId", async () => {
    const { impl, calls } = stubFetch(200, CREATED);
    const tool = toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    );
    await tool?.invoke(INPUT);
    await tool?.invoke(INPUT);
    const rid = (i: number) =>
      (
        bodyOf(calls[i] as { init: RequestInit }).conferenceData as {
          createRequest?: { requestId?: string };
        }
      )?.createRequest?.requestId;
    expect(rid(0)).toBeTruthy();
    expect(rid(1)).toBeTruthy();
    expect(rid(0)).not.toBe(rid(1));
  });

  test("the returned event exposes meetLink (hangoutLink), the link to hand the customer", async () => {
    const { impl } = stubFetch(200, CREATED);
    const out = (await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke(INPUT)) as string;
    expect(JSON.parse(out)).toMatchObject({
      id: "ev9",
      meetLink: "https://meet.google.com/abc-defg-hij",
    });
  });

  test("createMeetLink: false keeps today's body and URL (calendar as a pure busy-block)", async () => {
    const { impl, calls } = stubFetch(200, { id: "ev9" });
    await toolFor(
      "calendar_create_event",
      { createMeetLink: false },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(INPUT);
    expect(calls[0]?.url).not.toContain("conferenceDataVersion");
    expect(
      bodyOf(calls[0] as { init: RequestInit }).conferenceData,
    ).toBeUndefined();
  });

  test("a pending room is re-read once so the reply still carries meetLink", async () => {
    // NOTE: the POST answers without hangoutLink (createRequest still pending); one follow-up GET has it.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses: unknown[] = [
      {
        ...CREATED,
        hangoutLink: undefined,
        conferenceData: {
          createRequest: { status: { statusCode: "pending" } },
        },
      },
      CREATED,
    ];
    let n = 0;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = responses[Math.min(n, responses.length - 1)];
      n += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = (await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke(INPUT)) as string;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.method).toBe("GET");
    expect(JSON.parse(out)).toMatchObject({
      meetLink: "https://meet.google.com/abc-defg-hij",
    });
  });
});
