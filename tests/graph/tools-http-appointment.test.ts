import { describe, expect, test } from "bun:test";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";

// (#352) The registration an operator's HTTP tool declares, exercised through the tool itself: what
// it sends to the model is unchanged, and the appointment reaches the same two closures the Calendar
// toolpack uses.

const PUBLIC = "8.8.8.8";

function stubFetch(status: number, bodyText: string) {
  return (async () =>
    new Response(bodyText, {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "feegow_create_appointment",
    method: "POST",
    urlTemplate: `https://${PUBLIC}/v1/appointments`,
    allowedHosts: [PUBLIC],
    headers: {},
    inputSchema: {},
    credentialRef: null,
    ...over,
  };
}

const BOOK = {
  action: "book",
  idPath: "data.id",
  startPath: "data.start",
  summaryPath: "data.title",
};

interface Booked {
  eventId: string;
  provider?: string;
  tool?: string;
  calendarId?: string | null;
  startISO: string;
  credentialRef: string | null;
  summary: string | null;
  reminders: { offsetsHours: number[]; askConfirmationOnLast: boolean } | null;
}

function harness(
  over: Partial<HttpToolDef>,
  status: number,
  body: string,
  timezone?: string,
) {
  const booked: Booked[] = [];
  const cancelled: Array<{
    id: string;
    provider?: string;
    tool?: string;
  }> = [];
  const errors: Array<{ phase: string; message: string; detail?: unknown }> =
    [];
  const tool = buildHttpTool(def(over), {
    resolveCredential: async () => null,
    fetchImpl: stubFetch(status, body),
    timezone,
    appointmentBooked: async (a) => {
      booked.push(a as unknown as Booked);
    },
    cancelAppointment: async (id, opts) => {
      cancelled.push({ id, provider: opts?.provider, tool: opts?.tool });
    },
    onSideEffectError: (e) => {
      errors.push({
        phase: e.phase,
        message: e.err instanceof Error ? e.err.message : String(e.err),
        detail: e.detail,
      });
    },
  });
  return { tool, booked, cancelled, errors };
}

describe("an HTTP tool that declares a booking", () => {
  test("records the appointment, and the model sees exactly what it saw before", async () => {
    const body =
      '{"data":{"id":"ap_8842","start":"2026-09-02T14:00:00-03:00","title":"Consulta - Dra. X"}}';
    const h = harness({ appointment: BOOK }, 200, body);
    const out = (await h.tool.invoke({})) as unknown as string;
    expect(h.booked).toHaveLength(1);
    expect(h.booked[0]).toMatchObject({
      eventId: "ap_8842",
      startISO: "2026-09-02T14:00:00-03:00",
      summary: "Consulta - Dra. X",
      // No Google behind it, and every field that would name one says so. The null credential is
      // what tells the reminder handler there is nothing to ask about this appointment (#376); the
      // provider is what tells the per-turn prompt block the same thing, since a record carries no
      // credential — without it the block hands the model calendar_cancel_event and a Feegow id.
      provider: "declared",
      calendarId: null,
      credentialRef: null,
      reminders: null,
    });
    // The tool's own answer is untouched: the registration is a side effect, never a return value.
    expect(String(out)).toContain("HTTP 200");
    expect(String(out)).toContain("ap_8842");
    expect(h.errors).toEqual([]);
  });

  test("declared offsets arm reminders; absent offsets arm none", async () => {
    const body = '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}';
    const withOffsets = harness(
      {
        appointment: {
          ...BOOK,
          reminderOffsetsHours: [24, 1],
          askConfirmationOnLast: true,
        },
      },
      200,
      body,
    );
    await withOffsets.tool.invoke({});
    expect(withOffsets.booked[0]?.reminders).toEqual({
      offsetsHours: [24, 1],
      askConfirmationOnLast: true,
    });
    // The control on the same body and the same declaration minus the offsets.
    const without = harness({ appointment: BOOK }, 200, body);
    await without.tool.invoke({});
    expect(without.booked[0]?.reminders).toBeNull();
  });

  test("a cancel declaration retires the record by the same id", async () => {
    const h = harness(
      { appointment: { action: "cancel", idPath: "id" } },
      200,
      '{"id":"ap_8842"}',
    );
    await h.tool.invoke({});
    expect(h.cancelled).toEqual([
      {
        id: "ap_8842",
        provider: "declared",
        tool: "feegow_create_appointment",
      },
    ]);
    expect(h.booked).toEqual([]);
  });

  // An id is only unique WITHIN the system that issued it. Two operator systems that both count
  // from 1 share the record key and the reminder dedupe key, so the second booking moves the first
  // one and a cancel on either retires the other. The slug is what keeps the two apart, and the
  // book and cancel tools of one system have to carry the SAME slug.
  test("the declared provider travels with the booking, on book and on cancel", async () => {
    const book = harness(
      { appointment: { ...BOOK, provider: "feegow" } },
      200,
      '{"data":{"id":"42","start":"2026-09-02T14:00:00-03:00"}}',
    );
    await book.tool.invoke({});
    expect(book.booked[0]).toMatchObject({
      eventId: "42",
      provider: "feegow",
    });
    const cancel = harness(
      {
        name: "feegow_cancel_appointment",
        appointment: { action: "cancel", idPath: "id", provider: "feegow" },
      },
      200,
      '{"id":"42"}',
    );
    await cancel.tool.invoke({});
    expect(cancel.cancelled).toEqual([
      { id: "42", provider: "feegow", tool: "feegow_cancel_appointment" },
    ]);
  });

  // The closure turns its own failures into a flowlog line, and the line names a tool. Reporting
  // them all against `google_calendar` points the operator of a broken declaration at an
  // integration they may not even have configured — and the tool that has to be fixed is this one.
  test("the booking names the tool that made it, so a failure is attributed to it", async () => {
    const h = harness(
      { appointment: BOOK },
      200,
      '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}',
    );
    await h.tool.invoke({});
    expect(h.booked[0]?.tool).toBe("feegow_create_appointment");
  });

  // The row can hold a shape the reader refuses — a hand-written API call, a direct DB write, or a
  // declaration written by a version that spelled it differently. It has to read as "declares
  // nothing", not as a half-declaration to act on: reading `idPath` off it would hand `undefined`
  // to the path walker.
  test("a declaration the reader refuses is inert, and does not throw", async () => {
    for (const bad of [
      { action: "book", idPath: "data.id" },
      { action: "reschedule", idPath: "data.id", startPath: "data.start" },
      { idPath: "data.id", startPath: "data.start" },
      { action: "book", idPath: "data[0].id", startPath: "data.start" },
      "book",
      42,
    ]) {
      const h = harness(
        { appointment: bad },
        200,
        '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}',
      );
      const out = (await h.tool.invoke({})) as unknown as string;
      expect(String(out)).toContain("HTTP 200");
      expect(h.booked).toEqual([]);
      expect(h.cancelled).toEqual([]);
      expect(h.errors).toEqual([]);
    }
  });

  test("a tool that declares nothing records nothing", async () => {
    const h = harness(
      {},
      200,
      '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}',
    );
    await h.tool.invoke({});
    expect(h.booked).toEqual([]);
    expect(h.cancelled).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  // A 404 an operator declared a RESULT (issue #59) is a lookup saying "no record". Registering an
  // appointment out of it would invent one from the response that says there is none.
  test("a non-2xx records nothing, even when the operator declared it a result", async () => {
    const h = harness(
      { appointment: BOOK, expectedStatuses: [404] },
      404,
      '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}',
    );
    const out = (await h.tool.invoke({})) as unknown as string;
    expect(String(out)).toContain("HTTP 404");
    expect(h.booked).toEqual([]);
  });

  test("a path that does not resolve is REPORTED, and names itself", async () => {
    const h = harness({ appointment: BOOK }, 200, '{"data":{"title":"x"}}');
    const out = (await h.tool.invoke({})) as unknown as string;
    // The booking is real and already made, so the tool still succeeds for the model.
    expect(String(out)).toContain("HTTP 200");
    expect(h.booked).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.phase).toBe("appointment_declaration");
    expect(h.errors[0]?.message).toContain("data.id");
    expect(h.errors[0]?.message).toContain("data.start");
  });

  test("a response that is not JSON is reported, not thrown", async () => {
    const h = harness({ appointment: BOOK }, 200, "<html>ok</html>");
    const out = (await h.tool.invoke({})) as unknown as string;
    expect(String(out)).toContain("HTTP 200");
    expect(h.errors[0]?.phase).toBe("appointment_declaration");
    expect(h.errors[0]?.message).toContain("not JSON");
  });

  test("a registration that throws never reaches the model", async () => {
    const errors: string[] = [];
    const tool = buildHttpTool(def({ appointment: BOOK }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch(
        200,
        '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}',
      ),
      appointmentBooked: async () => {
        throw new Error("scheduler unavailable");
      },
      onSideEffectError: (e) => {
        errors.push(e.phase);
      },
    });
    const out = (await tool.invoke({})) as unknown as string;
    expect(String(out)).toContain("HTTP 200");
    expect(errors).toEqual(["appointment_register"]);
  });

  test("without the closures wired (the playground), a declaration is inert", async () => {
    const tool = buildHttpTool(def({ appointment: BOOK }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch(
        200,
        '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}',
      ),
    });
    const out = (await tool.invoke({})) as unknown as string;
    expect(String(out)).toContain("HTTP 200");
  });
});

// (#352, round 12) A great many booking APIs answer with a bare local timestamp. `14:00` is two in
// the afternoon WHERE THE OPERATOR IS, and everything downstream reads the start through
// `parseStartMs`, which treats an offset-less datetime as UTC — right for a value that already came
// through here, three hours wrong for one that did not. The customer would be shown 14:00 and
// reminded for 11:00, with nothing anywhere reporting it.
describe("an offset-less start is read in the agent's own zone", () => {
  const bodyAt = (start: string) =>
    JSON.stringify({ data: { id: "ap_1", start, title: "Consulta" } });

  test("the wall clock is kept and the offset is made explicit", async () => {
    const { tool, booked, errors } = harness(
      { appointment: BOOK },
      200,
      bodyAt("2026-09-02T14:00:00"),
      "America/Sao_Paulo",
    );
    await tool.invoke({});
    expect(errors).toEqual([]);
    // The STRING keeps 14:00, because it is what the reminder says out loud; only the offset is added.
    expect(booked[0]?.startISO).toBe("2026-09-02T14:00:00-03:00");
    // And it is the right instant: 17:00 UTC, not 14:00 UTC.
    expect(Date.parse(booked[0]?.startISO ?? "")).toBe(
      Date.parse("2026-09-02T17:00:00Z"),
    );
  });

  test("a zone with a different offset resolves differently, on the same input", async () => {
    const { tool, booked } = harness(
      { appointment: BOOK },
      200,
      bodyAt("2026-09-02T14:00:00"),
      "Europe/Lisbon",
    );
    await tool.invoke({});
    expect(booked[0]?.startISO).toBe("2026-09-02T14:00:00+01:00");
  });

  test("a start that already says where it is passes through untouched", async () => {
    const { tool, booked } = harness(
      { appointment: BOOK },
      200,
      bodyAt("2026-09-02T14:00:00-05:00"),
      "America/Sao_Paulo",
    );
    await tool.invoke({});
    expect(booked[0]?.startISO).toBe("2026-09-02T14:00:00-05:00");
  });

  // The other half of the same question, and the one `exists` cannot answer: on a fall-back night the
  // wall clock happens TWICE, an hour apart, and both readings are real. Guessing picks one and moves
  // the appointment an hour, silently.
  test("a wall clock the zone repeats is reported, not guessed", async () => {
    // 2026-11-01 is the fall-back in New York: 01:30 exists at -04:00 and again at -05:00.
    const { tool, booked, errors } = harness(
      { appointment: BOOK },
      200,
      bodyAt("2026-11-01T01:30:00"),
      "America/New_York",
    );
    await tool.invoke({});
    expect(booked).toEqual([]);
    expect(errors[0]?.message).toContain("data.start");
  });

  // The control on the other side of the same night: an hour later there is only one 02:30, and it
  // resolves normally. Without this the test above would pass against a build that refused the whole
  // zone, or the whole day.
  test("an unambiguous hour on the same night still resolves", async () => {
    const { tool, booked, errors } = harness(
      { appointment: BOOK },
      200,
      bodyAt("2026-11-01T02:30:00"),
      "America/New_York",
    );
    await tool.invoke({});
    expect(errors).toEqual([]);
    expect(booked[0]?.startISO).toBe("2026-11-01T02:30:00-05:00");
  });

  test("a wall clock the zone skipped is reported, not guessed", async () => {
    // 2026-09-06 is the DST spring-forward in Santiago: 00:30 does not exist that day.
    const { tool, booked, errors } = harness(
      { appointment: BOOK },
      200,
      bodyAt("2026-09-06T00:30:00"),
      "America/Santiago",
    );
    await tool.invoke({});
    expect(booked).toEqual([]);
    expect(errors[0]?.message).toContain("data.start");
  });
});
