import { describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
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

// Since #345 the write tools READ availability before writing, so a create/update fixture has to
// answer the freeBusy query too. Free by default: these tests are about what the write SENDS, not
// about the booking rule (that one has its own file).
function stubWriteFetch(
  json: unknown,
  busy: { start: string; end: string }[] = [],
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    calls.push({ url: u, init: i });
    let body = json;
    if (u.includes("/freeBusy")) {
      const items = (JSON.parse(String(i.body)) as { items: { id: string }[] })
        .items;
      const calendars: Record<string, { busy: unknown }> = {};
      for (const it of items) calendars[it.id] = { busy };
      body = { calendars };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// The requests that MUTATE, past the availability reads that now precede them.
function writeCalls(calls: Array<{ url: string; init: RequestInit }>) {
  return calls.filter(
    (c) =>
      c.url.includes("/events") &&
      (c.init.method === "POST" || c.init.method === "PATCH"),
  );
}

// The request that MUTATES, past the availability read that now precedes it.
function writeCall(calls: Array<{ url: string; init: RequestInit }>) {
  return calls.find(
    (c) =>
      c.url.includes("/events") &&
      (c.init.method === "POST" || c.init.method === "PATCH"),
  ) as { url: string; init: RequestInit };
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

  // Several allowed calendars is the ONLY case where this boundary exists: with a single one the arg
  // is not even exposed (see the pinned-calendar suite below), so there is no value to fence.
  test("a calendarId arg outside the allowlist is rejected, no fetch (injection boundary)", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    const out = (await toolFor(
      "calendar_list_events",
      { calendarIds: ["a@g.com", "b@g.com"] },
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

// A support report: an integration with ONE allowed calendar, and the agent calling availability with
// calendarId set to a string that is not a calendar at all. The tool refused, and only omitting the
// arg worked. The arg was offered with no hint of a valid value, because the <allowed_calendars> block
// is deliberately suppressed when there is nothing to choose.
describe("google calendar toolpack — a single allowed calendar is pinned", () => {
  const PINNED = "clinic@group.calendar.google.com";
  const ONE = {
    calendarIds: [PINNED],
    calendarLabels: { [PINNED]: "Clinic" },
  };
  const SEVERAL = {
    calendarIds: [PINNED, "second@group.calendar.google.com"],
    calendarLabels: { [PINNED]: "Clinic" },
  };
  // What a model with no valid value in sight fills the optional arg with.
  const INVENTED = "My Calendar Integration";
  const EVERY_TOOL = googleCalendarToolpack.toolSpecs.map((s) => s.name);

  function argsOf(tool: { schema: unknown } | undefined): string[] {
    const shape = (tool?.schema as { shape?: Record<string, unknown> })?.shape;
    return Object.keys(shape ?? {});
  }

  test("no tool offers a calendarId arg: there is nothing to pick", () => {
    expect(EVERY_TOOL).toHaveLength(6);
    for (const name of EVERY_TOOL) {
      expect(argsOf(toolFor(name, ONE, baseCtx()))).not.toContain("calendarId");
    }
  });

  test("with several allowed calendars every tool keeps the arg", () => {
    for (const name of EVERY_TOOL) {
      expect(argsOf(toolFor(name, SEVERAL, baseCtx()))).toContain("calendarId");
    }
  });

  test("availability: an invented calendarId is dropped, not refused", async () => {
    // Google keys the freeBusy response by the calendar it was asked about, so the stub answers for
    // the pinned one: a response keyed by the invented name would be a fixture the API cannot produce.
    const { impl, calls } = stubFetch(200, {
      calendars: { [PINNED]: { busy: [] } },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      ONE,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
      calendarId: INVENTED,
    })) as string;
    expect(out).not.toContain("not allowed");
    expect(calls[0]?.url).toContain("/freeBusy");
    expect(bodyOf(calls[0] as { init: RequestInit })).toMatchObject({
      items: [{ id: PINNED }],
    });
  });

  test("list: an invented calendarId is dropped, not refused", async () => {
    const { impl, calls } = stubFetch(200, { items: [] });
    const out = (await toolFor(
      "calendar_list_events",
      ONE,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ calendarId: INVENTED })) as string;
    expect(out).not.toContain("not allowed");
    expect(calls[0]?.url).toContain(
      `/calendars/${encodeURIComponent(PINNED)}/events`,
    );
  });

  test("the description names the pinned calendar instead of listing options", () => {
    const pinned = toolFor("calendar_check_availability", ONE, baseCtx());
    expect(pinned?.description).toContain(`<active_calendar name="Clinic"`);
    expect(pinned?.description).toContain(`id="${PINNED}"`);
    expect(pinned?.description).not.toContain("<allowed_calendars>");
  });

  test("with several allowed calendars the description still lists them", () => {
    const many = toolFor("calendar_check_availability", SEVERAL, baseCtx());
    expect(many?.description).toContain("<allowed_calendars>");
    expect(many?.description).not.toContain("<active_calendar");
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
    const { impl, calls } = stubWriteFetch({ id: "ev_1" });
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Consulta",
      start: "2099-06-22T14:00:00-03:00",
      end: "2099-06-22T15:00:00-03:00",
      // attendees is no longer in the schema; even if passed, it must never reach Google.
      attendees: ["lead@example.com"],
    });
    const body = bodyOf(writeCall(calls));
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
    const { impl } = stubWriteFetch({
      id: "ev_1",
      start: { dateTime: "2099-06-23T10:00:00-03:00" },
    });
    const scheduled: Array<{
      eventId: string;
      calendarId: string;
      startISO: string;
      credentialRef: string | null;
      reminders: {
        offsetsHours: number[];
        askConfirmationOnLast: boolean;
      } | null;
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
        appointmentBooked: async (a) => {
          scheduled.push(a);
        },
      }),
    )?.invoke({
      summary: "Consulta",
      start: "2099-06-23T10:00:00-03:00",
      end: "2099-06-23T11:00:00-03:00",
    });
    expect(scheduled).toHaveLength(1);
    // The policy (offsets + confirmation) flows from the integration config, not the agent.
    expect(scheduled[0]).toMatchObject({
      eventId: "ev_1",
      calendarId: "primary",
      startISO: "2099-06-23T10:00:00-03:00",
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
    });
  });

  // (#376) The reminder toggle decides the REMINDERS and nothing else. It used to decide whether the
  // toolpack said anything at all, so an integration with reminders off booked appointments the
  // platform never heard of: no follow-up pause, no console indicator, no block in the agent's own
  // prompt. Asserting `reminders: null` rather than "not called" is the whole point of the test.
  test("create still reports the booking when the integration has reminders disabled, arming none", async () => {
    const { impl, calls } = stubWriteFetch({
      id: "ev_2",
      start: { dateTime: "2099-06-23T10:00:00-03:00" },
    });
    const booked: Array<{ eventId: string; reminders: unknown }> = [];
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({
        fetchImpl: impl,
        appointmentBooked: async (a) => {
          booked.push(a);
        },
      }),
    )?.invoke({
      summary: "Consulta",
      start: "2099-06-23T10:00:00-03:00",
      end: "2099-06-23T11:00:00-03:00",
    });
    // The create has to LAND, or the assertions below would be true of a refused write too.
    expect(writeCall(calls)).toBeDefined();
    expect(booked).toHaveLength(1);
    expect(booked[0]?.eventId).toBe("ev_2");
    expect(booked[0]?.reminders).toBeNull();
  });

  test("cancel retires the appointment via ctx", async () => {
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
        cancelAppointment: async (id) => {
          cancelled.push(id);
        },
      }),
    )?.invoke({ eventId: "ev_9" });
    expect(cancelled).toEqual(["ev_9"]);
  });

  // (#376) 410 Gone is a SUCCESS shape, and it used to return before the cleanup. The event is gone
  // in Google either way, so leaving the record behind kept the follow-up paused and the appointment
  // in the prompt until its start passed. It matters more now that the record exists even for an
  // integration with reminders switched off, where there was previously no row to leave behind.
  test("cancel retires the appointment on 410 Gone too, not only on 204", async () => {
    const calls: string[] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "DELETE") return new Response("", { status: 410 });
      return new Response(
        JSON.stringify({ id: "ev_gone", extendedProperties: stampedExt }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const cancelled: string[] = [];
    const out = await toolFor(
      "calendar_cancel_event",
      {},
      baseCtx({
        fetchImpl: impl,
        cancelAppointment: async (id) => {
          cancelled.push(id);
        },
      }),
    )?.invoke({ eventId: "ev_gone" });
    // The DELETE has to have been ATTEMPTED, or "the record was retired" would also be true of a
    // path that never reached Google.
    expect(calls).toContain("DELETE");
    expect(cancelled).toEqual(["ev_gone"]);
    expect(out).toContain("already cancelled");
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
    const { impl, calls } = stubWriteFetch({
      id: "ev_1",
      summary: "Call",
      start: { dateTime: "2099-06-22T14:00:00-03:00" },
      end: { dateTime: "2099-06-22T15:00:00-03:00" },
      htmlLink: "https://cal/ev_1",
    });
    const out = (await toolFor(
      "calendar_create_event",
      { timeZone: "America/Bahia" },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Call",
      start: "2099-06-22T14:00:00-03:00",
      end: "2099-06-22T15:00:00-03:00",
    })) as string;
    const body = bodyOf(writeCall(calls));
    expect(body.start).toEqual({
      dateTime: "2099-06-22T14:00:00-03:00",
      timeZone: "America/Bahia",
    });
    expect(JSON.parse(out)).toMatchObject({
      id: "ev_1",
      start: "2099-06-22T14:00:00-03:00",
      htmlLink: "https://cal/ev_1",
    });
  });

  test("create: a bare date is refused — a whole day is never a bookable slot", async () => {
    const { impl, calls } = stubWriteFetch({ id: "ev_2" });
    const out = (await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Holiday",
      start: "2099-06-22",
      end: "2099-06-23",
    })) as string;
    expect(writeCall(calls)).toBeUndefined();
    expect(out).toContain("start and end time");
  });

  test("create: with no configured timeZone, timed events anchor to São Paulo", async () => {
    const { impl, calls } = stubWriteFetch({ id: "ev_4" });
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      summary: "Call",
      start: "2099-06-22T14:00:00-03:00",
      end: "2099-06-22T15:00:00-03:00",
    });
    const body = bodyOf(writeCall(calls));
    expect(body.start).toEqual({
      dateTime: "2099-06-22T14:00:00-03:00",
      timeZone: "America/Sao_Paulo",
    });
  });

  // A patch that sets only dateTime leaves the all-day `date` on the event, and Google rejects an
  // event carrying both (HTTP 400). Both directions must null the field they replace.
  test("update: all-day → timed nulls the date field", async () => {
    // An all-day event created before #345 can still be MOVED onto a bookable slot, and the patch
    // has to clear the `date` it replaces (Google rejects an event carrying both, HTTP 400).
    const { impl, calls } = stubWriteFetch({
      id: "ev_5",
      extendedProperties: stampedExt,
      start: { date: "2099-06-22" },
      end: { date: "2099-06-23" },
    });
    await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_5",
      start: "2099-06-22T14:00:00-03:00",
      end: "2099-06-22T15:00:00-03:00",
    });
    const body = bodyOf(writeCall(calls));
    expect(body.start).toEqual({
      dateTime: "2099-06-22T14:00:00-03:00",
      timeZone: "America/Sao_Paulo",
      date: null,
    });
    expect(body.end).toEqual({
      dateTime: "2099-06-22T15:00:00-03:00",
      timeZone: "America/Sao_Paulo",
      date: null,
    });
  });

  test("update: a move to a whole day is refused, and nothing is patched", async () => {
    const { impl, calls } = stubWriteFetch({
      id: "ev_6",
      extendedProperties: stampedExt,
      start: { dateTime: "2099-06-22T14:00:00-03:00" },
      end: { dateTime: "2099-06-22T15:00:00-03:00" },
    });
    const out = (await toolFor(
      "calendar_update_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      eventId: "ev_6",
      start: "2099-06-22",
      end: "2099-06-23",
    })) as string;
    expect(writeCall(calls)).toBeUndefined();
    expect(out).toContain("start and end time");
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
          exceptions: [],
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

  test("a date exception on the schedule removes that day's slots entirely (issue #129)", async () => {
    const day = spWeekday("2099-06-22T09:00:00-03:00");
    const { impl, calls } = stubFetch(200, {
      calendars: { primary: { busy: [] } },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      {
        businessHoursId: "5",
        slotDurationMinutes: 60,
        slotGranularityMinutes: 60,
      },
      baseCtx({
        fetchImpl: impl,
        resolveBusinessHours: async () => ({
          // The same morning grid as the test above, so the ONLY difference is the exception.
          windows: [{ day, start: "09:00", end: "12:00" }],
          exceptions: [{ date: "2099-06-22", label: "Feriado", ranges: [] }],
          timezone: TZ,
        }),
      }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
    })) as string;
    const parsed = JSON.parse(out) as { slots: { start: string }[] };
    expect(parsed.slots).toEqual([]);
    // The busy lookup still happened: the schedule is what emptied the list, not a short-circuit that
    // would also hide a real calendar error.
    expect(calls.length).toBeGreaterThan(0);
  });

  test("a half-day exception bounds the slots to its own range, not the grid's", async () => {
    const day = spWeekday("2099-06-22T09:00:00-03:00");
    const { impl } = stubFetch(200, { calendars: { primary: { busy: [] } } });
    const out = (await toolFor(
      "calendar_check_availability",
      {
        businessHoursId: "5",
        slotDurationMinutes: 60,
        slotGranularityMinutes: 60,
      },
      baseCtx({
        fetchImpl: impl,
        resolveBusinessHours: async () => ({
          windows: [{ day, start: "09:00", end: "18:00" }],
          exceptions: [
            {
              date: "2099-06-22",
              label: "Véspera",
              ranges: [{ start: "09:00", end: "11:00" }],
            },
          ],
          timezone: TZ,
        }),
      }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
    })) as string;
    const parsed = JSON.parse(out) as { slots: { start: string }[] };
    expect(parsed.slots.map((s) => localHM(s.start))).toEqual([
      "09:00",
      "10:00",
    ]);
  });

  // Regression: the spacing between start times is the operator's business rule (a 1h school visit
  // offered on the half hour). While granularityMinutes was on the schema, the model could send 15
  // and get back 14:15 — a real, bookable slot the school does not actually offer. The arg is gone
  // now, so this also pins the strip: a residual key from an older tool definition never reaches the
  // body, which is why no handler guard is needed.
  test("availability IGNORES a granularity the model sends", async () => {
    const day = spWeekday("2099-06-22T14:00:00-03:00");
    const { impl } = stubFetch(200, { calendars: { primary: { busy: [] } } });
    const out = (await toolFor(
      "calendar_check_availability",
      {
        businessHoursId: "5",
        slotDurationMinutes: 60,
        slotGranularityMinutes: 30,
      },
      baseCtx({
        fetchImpl: impl,
        resolveBusinessHours: async () => ({
          windows: [{ day, start: "14:00", end: "16:00" }],
          exceptions: [],
          timezone: TZ,
        }),
      }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
      // What the model actually sent in production. The pinned 30 must win.
      granularityMinutes: 15,
      slotDurationMinutes: 15,
    })) as string;
    const parsed = JSON.parse(out) as { slots: { start: string }[] };
    expect(parsed.slots.map((s) => localHM(s.start))).toEqual([
      "14:00",
      "14:30",
      "15:00",
    ]);
  });

  // A config with no slotGranularityMinutes is the case the console cannot produce but the API can:
  // there is no "let the AI choose" for spacing, so a missing key is an operator who never chose, not
  // one who delegated. The runtime default must win over the model just the same.
  test("availability IGNORES a granularity the model sends with NO spacing configured", async () => {
    const day = spWeekday("2099-06-22T14:00:00-03:00");
    const { impl } = stubFetch(200, { calendars: { primary: { busy: [] } } });
    const out = (await toolFor(
      "calendar_check_availability",
      { businessHoursId: "5", slotDurationMinutes: 60 },
      baseCtx({
        fetchImpl: impl,
        resolveBusinessHours: async () => ({
          windows: [{ day, start: "14:00", end: "16:00" }],
          exceptions: [],
          timezone: TZ,
        }),
      }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
      granularityMinutes: 5,
    })) as string;
    const parsed = JSON.parse(out) as { slots: { start: string }[] };
    // The toolpack default (15), not the 5 the model asked for.
    expect(parsed.slots.map((s) => localHM(s.start))).toEqual([
      "14:00",
      "14:15",
      "14:30",
      "14:45",
      "15:00",
    ]);
  });

  test("availability never offers granularityMinutes, and hides slotDurationMinutes when pinned", () => {
    const keysFor = (config: Record<string, unknown>) => {
      const tool = toolFor("calendar_check_availability", config, baseCtx({}));
      if (!tool) throw new Error("calendar_check_availability was not built");
      const { shape } = tool.schema as unknown as {
        shape: Record<string, unknown>;
      };
      return Object.keys(shape);
    };
    // The spacing is the operator's at every configuration, so the arg exists in none of them.
    for (const config of [
      { slotDurationMinutes: 60, slotGranularityMinutes: 30 },
      { slotGranularityMinutes: 30 },
      {},
    ]) {
      expect(keysFor(config)).not.toContain("granularityMinutes");
    }
    // Pinned length ⇒ the arg is gone, so the model cannot redefine the business rule per call.
    const pinned = keysFor({
      slotDurationMinutes: 60,
      slotGranularityMinutes: 30,
    });
    expect(pinned).not.toContain("slotDurationMinutes");
    expect(pinned).toContain("timeMin");
    // "Let the AI choose" ⇒ the arg stays and the model picks per request (a clinic whose
    // appointments genuinely vary).
    expect(keysFor({ slotGranularityMinutes: 30 })).toContain(
      "slotDurationMinutes",
    );
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
    start: { dateTime: "2099-06-22T14:00:00-03:00" },
    end: { dateTime: "2099-06-22T15:00:00-03:00" },
    htmlLink: "https://cal/ev9",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  };
  const INPUT = {
    summary: "Demo",
    start: "2099-06-22T14:00:00-03:00",
    end: "2099-06-22T15:00:00-03:00",
  };

  test("create asks Google for a Meet room by default (body + conferenceDataVersion=1)", async () => {
    const { impl, calls } = stubWriteFetch(CREATED);
    await toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke(INPUT);
    expect(writeCall(calls).url).toContain("conferenceDataVersion=1");
    const body = bodyOf(writeCall(calls));
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
    const { impl, calls } = stubWriteFetch(CREATED);
    const tool = toolFor(
      "calendar_create_event",
      {},
      baseCtx({ fetchImpl: impl }),
    );
    await tool?.invoke(INPUT);
    await tool?.invoke(INPUT);
    const rid = (i: number) =>
      (
        bodyOf(writeCalls(calls)[i] as { init: RequestInit })
          .conferenceData as {
          createRequest?: { requestId?: string };
        }
      )?.createRequest?.requestId;
    expect(rid(0)).toBeTruthy();
    expect(rid(1)).toBeTruthy();
    expect(rid(0)).not.toBe(rid(1));
  });

  test("the returned event exposes meetLink (hangoutLink), the link to hand the customer", async () => {
    const { impl } = stubWriteFetch(CREATED);
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
    const { impl, calls } = stubWriteFetch({ id: "ev9" });
    await toolFor(
      "calendar_create_event",
      { createMeetLink: false },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(INPUT);
    expect(writeCall(calls).url).not.toContain("conferenceDataVersion");
    expect(bodyOf(writeCall(calls)).conferenceData).toBeUndefined();
  });

  test("a pending room is re-read once so the reply still carries meetLink", async () => {
    // NOTE: the POST answers without hangoutLink (createRequest still pending); one follow-up GET has it.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const pending = {
      ...CREATED,
      hangoutLink: undefined,
      conferenceData: {
        createRequest: { status: { statusCode: "pending" } },
      },
    };
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const i = init ?? {};
      calls.push({ url: u, init: i });
      const body = u.includes("/freeBusy")
        ? { calendars: { primary: { busy: [] } } }
        : i.method === "POST"
          ? pending
          : CREATED;
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
    const after = calls.slice(calls.indexOf(writeCall(calls)));
    expect(after).toHaveLength(2);
    expect(after[1]?.init.method).toBe("GET");
    expect(JSON.parse(out)).toMatchObject({
      meetLink: "https://meet.google.com/abc-defg-hij",
    });
  });
});

// NOTE: Integration failures must reach the flow log as failures (issue #40): invoked as a
// tool_call, a provider/credential failure returns a ToolMessage with status "error" (same friendly
// content), while bad model input stays a plain success — it is normal operation, not an outage.
describe("google calendar toolpack — integration failures are marked (issue #40)", () => {
  test("a non-2xx and a missing credential return ToolMessage status error", async () => {
    const { impl } = stubFetch(500, { error: "boom" });
    const http = (await toolFor(
      "calendar_list_events",
      {},
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      type: "tool_call",
      id: "call_cal_1",
      name: "calendar_list_events",
      args: {},
    })) as ToolMessage;
    expect(http.status).toBe("error");
    expect(String(http.content)).toContain("500");

    const notConnected = (await toolFor(
      "calendar_list_events",
      {},
      baseCtx({ resolveCredential: async () => null }),
    )?.invoke({
      type: "tool_call",
      id: "call_cal_2",
      name: "calendar_list_events",
      args: {},
    })) as ToolMessage;
    expect(notConnected.status).toBe("error");
    expect(String(notConnected.content)).toContain("not connected");
  });

  test("bad model input (range over 24h) is NOT marked as a failure", async () => {
    const out = (await toolFor(
      "calendar_check_availability",
      {},
      baseCtx(),
    )?.invoke({
      type: "tool_call",
      id: "call_cal_3",
      name: "calendar_check_availability",
      args: {
        timeMin: "2099-06-22T00:00:00-03:00",
        timeMax: "2099-06-24T00:00:00-03:00",
      },
    })) as ToolMessage;
    expect(out.status).toBe("success");
    expect(String(out.content).toLowerCase()).toContain("at most 24 hours");
  });
});

// Issue #100: a clinic with one calendar per professional. "Who can see me first?" used to force the
// model to call this tool once per calendar and merge the results itself, burning the turn's tool
// budget and risking a calendar never being asked. freeBusy already takes N calendars in ONE request,
// so aggregating costs the same round trip it always did.
describe("google calendar toolpack — aggregated availability (issue #100)", () => {
  const ANA = "ana@group.calendar.google.com";
  const PAULO = "paulo@group.calendar.google.com";
  const CLINIC = {
    calendarIds: [ANA, PAULO],
    calendarLabels: { [ANA]: "Dra. Ana", [PAULO]: "Dr. Paulo" },
    slotDurationMinutes: 60,
    slotGranularityMinutes: 60,
  };
  const RANGE = {
    timeMin: "2099-06-22T09:00:00-03:00",
    timeMax: "2099-06-22T12:00:00-03:00",
  };
  type AggSlot = {
    start: string;
    end: string;
    label: string;
    calendarId: string;
    calendarLabel?: string;
  };
  const parse = (out: string) =>
    JSON.parse(out) as {
      slots: AggSlot[];
      unavailableCalendars?: string[];
      coveredUntil?: string;
    };

  test("no calendarId asks every allowed calendar in ONE freeBusy request", async () => {
    const { impl, calls } = stubFetch(200, {
      calendars: { [ANA]: { busy: [] }, [PAULO]: { busy: [] } },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      CLINIC,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0] as { init: RequestInit })).toMatchObject({
      items: [{ id: ANA }, { id: PAULO }],
    });
    expect(parse(out).slots.length).toBe(6);
  });

  test("every slot carries the calendar that can actually take it", async () => {
    const { impl } = stubFetch(200, {
      calendars: {
        [ANA]: {
          busy: [
            {
              start: "2099-06-22T09:00:00-03:00",
              end: "2099-06-22T10:00:00-03:00",
            },
          ],
        },
        [PAULO]: { busy: [] },
      },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      CLINIC,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const nine = parse(out).slots.filter((s) => localHM(s.start) === "09:00");
    expect(nine).toHaveLength(1);
    expect(nine[0]?.calendarId).toBe(PAULO);
    expect(nine[0]?.calendarLabel).toBe("Dr. Paulo");
  });

  test("the merged list is chronological across calendars", async () => {
    const { impl } = stubFetch(200, {
      calendars: {
        [ANA]: {
          busy: [
            {
              start: "2099-06-22T09:00:00-03:00",
              end: "2099-06-22T11:00:00-03:00",
            },
          ],
        },
        [PAULO]: {
          busy: [
            {
              start: "2099-06-22T10:00:00-03:00",
              end: "2099-06-22T12:00:00-03:00",
            },
          ],
        },
      },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      CLINIC,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const times = parse(out).slots.map((s) => Date.parse(s.start));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("an explicit calendarId still asks that one calendar only", async () => {
    const { impl, calls } = stubFetch(200, {
      calendars: { [ANA]: { busy: [] } },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      CLINIC,
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ ...RANGE, calendarId: "Dra. Ana" })) as string;
    expect(bodyOf(calls[0] as { init: RequestInit })).toMatchObject({
      items: [{ id: ANA }],
    });
    expect(parse(out).slots.every((s) => s.calendarId === ANA)).toBe(true);
  });

  test("a calendar freeBusy could not read is EXCLUDED and named, never treated as free", async () => {
    // Including it with an empty busy list would offer a professional whose bookings we cannot see,
    // which is a double booking. Dropping it only under-offers.
    const { impl } = stubFetch(200, {
      calendars: {
        [ANA]: { busy: [] },
        [PAULO]: { errors: [{ domain: "global", reason: "notFound" }] },
      },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      CLINIC,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const parsed = parse(out);
    expect(parsed.slots.every((s) => s.calendarId === ANA)).toBe(true);
    expect(parsed.unavailableCalendars).toEqual(["Dr. Paulo"]);
  });

  test("a single calendar is NOT capped, even past the aggregate ceiling", async () => {
    // The earlier version of this test used a 12-hour hourly window, which is 12 slots: it asserted
    // the guarantee without ever reaching the ceiling it claimed did not apply. At the 5-minute floor
    // a near-24h range yields ~287 starts, which is past the 250 an aggregate query is bound to.
    const { impl } = stubFetch(200, { calendars: { [ANA]: { busy: [] } } });
    const out = (await toolFor(
      "calendar_check_availability",
      {
        ...CLINIC,
        calendarIds: [ANA],
        slotDurationMinutes: 5,
        slotGranularityMinutes: 5,
      },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      timeMin: "2099-06-22T00:00:00-03:00",
      timeMax: "2099-06-22T23:59:00-03:00",
    })) as string;
    const parsed = parse(out);
    expect(parsed.slots.length).toBeGreaterThan(250);
    expect(parsed.coveredUntil).toBeUndefined();
  });

  test("a batch that THROWS costs only its own calendars, like a batch that 500s", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}@x`);
    let n = 0;
    const impl = (async () => {
      if (n++ > 0) throw new Error("socket hang up");
      return new Response(
        JSON.stringify({
          calendars: Object.fromEntries(
            ids.slice(0, 10).map((id) => [id, { busy: [] }]),
          ),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, calendarIds: ids, calendarLabels: {} },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const parsed = parse(out);
    expect(parsed.unavailableCalendars).toEqual(ids.slice(10));
    expect(parsed.slots.length).toBeGreaterThan(0);
  });

  test("the calendarId ARG says omitting it searches everyone, not just the prose", async () => {
    // Where the model actually decides. The tool description says to omit it, but an optional field
    // is filled or skipped while reading the field, and the shared description ("Which calendar to
    // act on") argues the other way with a list of valid values in sight.
    const argDesc = (name: string) => {
      const tool = toolFor(name, CLINIC, baseCtx());
      if (!tool) throw new Error(`tool not built: ${name}`);
      const shape = (
        tool.schema as { shape: Record<string, { description?: string }> }
      ).shape;
      return shape.calendarId?.description ?? "";
    };
    const availability = argDesc("calendar_check_availability");
    expect(availability).toMatch(/omit/i);
    expect(availability).toMatch(/every calendar/i);
    // The acting tools must NOT inherit it: there, leaving it out is refused.
    expect(argDesc("calendar_create_event")).not.toMatch(/omit/i);
  });

  test("the tool description tells the model what coveredUntil means", async () => {
    // A field the model is never told about cannot be acted on, and a truncated list read as complete
    // is the model reporting later times unavailable.
    const desc = toolFor("calendar_check_availability", CLINIC, baseCtx())
      ?.description as string;
    expect(desc).toContain("coveredUntil");
    expect(desc).toContain("timeMin");
  });

  test("an afternoon is still offered: several calendars are not cut to their first few starts", async () => {
    // The reviewer's scenario. At the default 15-minute grain an eight-slot-per-calendar bound
    // exposes under two hours, so "do you have anything after lunch?" answers no while the afternoon
    // is free. Nothing may truncate the range.
    const { impl } = stubFetch(200, {
      calendars: { [ANA]: { busy: [] }, [PAULO]: { busy: [] } },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, slotDurationMinutes: 30, slotGranularityMinutes: 15 },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      timeMin: "2099-06-22T09:00:00-03:00",
      timeMax: "2099-06-22T18:00:00-03:00",
    })) as string;
    const slots = parse(out).slots;
    const afternoon = slots.filter(
      (s) => Number(localHM(s.start).slice(0, 2)) >= 14,
    );
    expect(afternoon.length).toBeGreaterThan(0);
    expect(new Set(afternoon.map((s) => s.calendarId))).toEqual(
      new Set([ANA, PAULO]),
    );
  });

  test("the query is BATCHED across every allowed calendar", async () => {
    // Google's calendarExpansionMax of 50 is a PER-REQUEST ceiling, so batching satisfies it. An
    // earlier revision trimmed the allowlist at 50 and reported the tail as unavailable, throwing
    // away calendars that one more batch would have covered.
    const many = Array.from({ length: 50 }, (_, i) => `c${i}@x`);
    const { impl, calls } = stubFetch(200, {
      calendars: Object.fromEntries(many.map((id) => [id, { busy: [] }])),
    });
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, calendarIds: many, calendarLabels: {} },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const asked = calls.flatMap(
      (c) => (bodyOf(c) as { items: { id: string }[] }).items,
    );
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(
        (bodyOf(c) as { items: unknown[] }).items.length,
      ).toBeLessThanOrEqual(10);
    }
    expect(asked.map((i) => i.id)).toEqual(many);
    expect(parse(out).unavailableCalendars).toBeUndefined();
  });

  test("an allowlist too large to aggregate is refused, and one calendar still works", async () => {
    // The bound sits on the calendar count rather than on each consequence (requests in flight, slot
    // entries, the always-kept first start time) because they all come from the same arbitrary-length
    // config array. Refusing names what the operator has to change; an explicit calendarId is
    // unaffected at any allowlist size.
    const ids = Array.from({ length: 51 }, (_, i) => `c${i}@x`);
    const { impl, calls } = stubFetch(200, {
      calendars: { "c0@x": { busy: [] } },
    });
    const refused = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, calendarIds: ids, calendarLabels: {} },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(refused).toContain("the limit is 50");
    expect(calls).toHaveLength(0);

    const ok = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, calendarIds: ids, calendarLabels: {} },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({ ...RANGE, calendarId: "c0@x" })) as string;
    expect(parse(ok).slots.length).toBeGreaterThan(0);
  });

  test('a 2xx whose body cannot be parsed is retriable, not "HTTP null"', async () => {
    const impl = (async () =>
      new Response("<html>proxy ate it</html>", {
        status: 200,
      })) as unknown as typeof fetch;
    const out = (await toolFor(
      "calendar_check_availability",
      CLINIC,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(out).toContain("could not be read");
    expect(out).not.toContain("null");
  });

  test("one failed batch costs only its own calendars, not the whole answer", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}@x`);
    let n = 0;
    const impl = (async () => {
      const first = n++ === 0;
      return new Response(
        JSON.stringify(
          first
            ? {
                calendars: Object.fromEntries(
                  ids.slice(0, 10).map((id) => [id, { busy: [] }]),
                ),
              }
            : {},
        ),
        { status: first ? 200 : 500 },
      );
    }) as unknown as typeof fetch;
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, calendarIds: ids, calendarLabels: {} },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const parsed = parse(out);
    expect(parsed.unavailableCalendars).toEqual(ids.slice(10));
    expect(
      parsed.slots.every((s) => ids.slice(0, 10).includes(s.calendarId)),
    ).toBe(true);
  });

  test("a calendar listed as BOTH operable and blocking still blocks its siblings", async () => {
    // freeBusy ignores transparent and all-day events, which is exactly the closure shape, so a
    // doubly-listed calendar has to be READ as a blocker for the others. Excluding every queried
    // calendar from the blocking read (an earlier revision) made that closure invisible to everyone.
    const { impl } = routedFetch([
      {
        match: "/freeBusy",
        json: { calendars: { [ANA]: { busy: [] }, [PAULO]: { busy: [] } } },
      },
      {
        match: "ana%40group",
        json: {
          items: [
            {
              start: { dateTime: "2099-06-22T09:00:00-03:00" },
              end: { dateTime: "2099-06-22T10:00:00-03:00" },
            },
          ],
        },
      },
    ]);
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, blockingCalendarIds: [ANA] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    const nine = parse(out).slots.filter((s) => localHM(s.start) === "09:00");
    // Blocked for Paulo (the sibling), and NOT self-blocked for Ana: her own freeBusy says free.
    expect(nine.map((s) => s.calendarId)).toEqual([ANA]);
  });

  test("a blocker whose only sibling went unreadable is not read at all", async () => {
    // The blocking read is decided from the calendars that ANSWERED, not the ones asked for. A
    // doubly-listed calendar applies to its siblings only, so with no readable sibling left the
    // request is pure risk: an error or a truncated page on it would refuse availability that is fine.
    const { impl, calls } = routedFetch([
      {
        match: "/freeBusy",
        json: {
          calendars: {
            [ANA]: { busy: [] },
            [PAULO]: { errors: [{ domain: "global", reason: "notFound" }] },
          },
        },
      },
    ]);
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, blockingCalendarIds: [ANA] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(calls).toHaveLength(1);
    expect(parse(out).slots.length).toBeGreaterThan(0);
  });

  test("an oversized answer stops at a whole start time and says where to continue", async () => {
    // 50 calendars over a working day is far past what one tool result can carry. The range must not
    // be collapsed silently: the caller is told the time to resume from.
    const ids = Array.from({ length: 50 }, (_, i) => `c${i}@x`);
    const { impl } = stubFetch(200, {
      calendars: Object.fromEntries(ids.map((id) => [id, { busy: [] }])),
    });
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, calendarIds: ids, calendarLabels: {} },
      baseCtx({ fetchImpl: impl }),
    )?.invoke({
      timeMin: "2099-06-22T09:00:00-03:00",
      timeMax: "2099-06-22T18:00:00-03:00",
    })) as string;
    const parsed = parse(out) as {
      slots: AggSlot[];
      coveredUntil?: string;
    };
    expect(parsed.slots.length).toBeLessThanOrEqual(250);
    expect(parsed.coveredUntil).toBeTruthy();
    // Whole start times only: every calendar that answered is present at each time returned.
    const perTime = new Map<string, number>();
    for (const s of parsed.slots)
      perTime.set(s.start, (perTime.get(s.start) ?? 0) + 1);
    expect([...new Set(perTime.values())]).toEqual([50]);
  });

  test("when NO calendar could be read it refuses instead of reporting nothing free", async () => {
    // An empty slot list reads as "this day is fully booked". Saying that because every calendar
    // failed would send the customer away from a clinic that is in fact open.
    const { impl } = stubFetch(200, {
      calendars: {
        [ANA]: { errors: [{ domain: "global", reason: "notFound" }] },
        [PAULO]: { errors: [{ domain: "global", reason: "notFound" }] },
      },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      CLINIC,
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(out).toContain("cannot be verified");
    expect(out).not.toContain("slots");
  });

  test("a single allowed calendar keeps the pinned shape, still tagged", async () => {
    const { impl, calls } = stubFetch(200, {
      calendars: { [ANA]: { busy: [] } },
    });
    const out = (await toolFor(
      "calendar_check_availability",
      { ...CLINIC, calendarIds: [ANA] },
      baseCtx({ fetchImpl: impl }),
    )?.invoke(RANGE)) as string;
    expect(bodyOf(calls[0] as { init: RequestInit })).toMatchObject({
      items: [{ id: ANA }],
    });
    expect(parse(out).slots.every((s) => s.calendarId === ANA)).toBe(true);
  });
});
