import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { z } from "zod";
import logger from "@/api/lib/logger";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { xmlAttr } from "@/lib/xml";
import { readAppointmentReminderConfig } from "@/modules/appointments/settings";
import { computeAvailableSlots } from "./calendar-slots";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

// Google Calendar OUTBOUND toolpack. The agent lists/creates/updates events and checks availability on
// an ALLOWLIST of calendars bound to the integration instance config (default the connected account's
// "primary"), so a prompt-injection cannot redirect reads/writes to a calendar outside that set. The
// OAuth access token comes from the vault by reference (kind `google_oauth`); prepare.ts's
// resolveCredential auto-refreshes it and hands us a fresh bearer — it never reaches the model / a tool
// arg / the return / the trace.
//
// Per-CUSTOMER isolation (a clinic's ONE shared calendar serves MANY WhatsApp contacts): every event
// the agent creates is stamped with `extendedProperties.private.secv4Contact = "<tenantId>:<contactDbId>"`
// — a value INJECTED from the trusted context, never a model arg. Listing filters server-side by that
// private property AND re-verifies each returned event's stamp (defense in depth), so a customer only
// ever sees their OWN appointments; updating re-fetches the event and refuses if the stamp does not
// match. Availability uses freeBusy (busy windows only, zero details), so other customers' bookings
// count as busy without leaking anything. Fail-closed: with no contact in scope (playground) the
// per-contact tools refuse instead of falling back to "all events".
//
// Security invariants (mirror asaas.ts):
//   - the set of operable calendars (`calendarIds`) + `timeZone` are bound to the INSTANCE CONFIG; a
//     tool's optional `calendarId` arg is validated against the allowlist, fail-closed (with a single
//     allowed calendar it is auto-selected; with several the model picks by name or id IN the set);
//   - the per-customer stamp is bound to ctx.contactDbId, never a tool arg;
//   - the bearer token flows ONLY into the Authorization header;
//   - the origin is a fixed constant (never interpolated); SSRF-guarded anyway;
//   - https-only, no redirects, bounded timeout + response.

const GCAL_ORIGIN = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 12_000;
// Generous bound: a list of 25 verbose event objects parses; a runaway response is still capped.
const MAX_RESPONSE_CHARS = 100_000;
const MAX_LIST_RESULTS = 25;
// Blocking-calendar fan-out bound: each configured blocking calendar costs one events.list request
// per availability call, so a runaway list would multiply latency + quota. Fail-closed above the
// cap (refuse, never silently check a subset).
const MAX_BLOCKING_CALENDARS = 10;

// Brazilian clinics are the default audience; absent an explicit config timeZone, anchor every timed
// event and freeBusy query to São Paulo so the agent's "14:00" is unambiguous.
const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

// The private-event key carrying the owning contact's stamp. Keys in extendedProperties.private are
// visible/queryable ONLY by our OAuth app, never by other apps or the customer.
const SECV4_CONTACT_KEY = "secv4Contact";

// The private-event key recording the attendance-confirmation timestamp (set by
// calendar_confirm_appointment, injected from code, never surfaced to the model).
const SECV4_CONFIRMED_KEY = "secv4Confirmed";
// Title prefix that marks a confirmed appointment (applied idempotently).
const CONFIRMED_PREFIX = "[CONFIRMADO] ";

// The allowlist of calendars the agent may operate on, bound to config. Empty/missing → [] (NO
// calendar): fail-closed, so the tools refuse until the operator explicitly picks a calendar, instead
// of silently falling back to the connected account's own "primary" (which would dump appointments on
// whoever connected the Google account). De-duplicated; path-encoded at call sites.
function resolveAllowedCalendarIds(config: Record<string, unknown>): string[] {
  const raw = config.calendarIds;
  if (Array.isArray(raw)) {
    const ids = raw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (ids.length > 0) return Array.from(new Set(ids));
  }
  return [];
}

// Calendars the agent must RESPECT but never operates on (holidays, closures, staff time off),
// designated by the operator in the instance config. Availability treats EVERY event on them as
// busy. De-duplicated; the active booking calendar is filtered out at the call site (its bookings
// already count via freeBusy, and "blocking" semantics on the booking calendar would also turn its
// transparent events into blocks).
function resolveBlockingCalendarIds(config: Record<string, unknown>): string[] {
  const raw = config.blockingCalendarIds;
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return Array.from(new Set(ids));
}

// NOTE: whether calendar_create_event asks Google for a Meet room. ON by default: an agent that books a
// "call" must hand the customer a real meeting room, not the calendar page (htmlLink). Operators who
// use the calendar purely as a busy-block turn it off in the integration config. When the connected
// account cannot create Meet rooms, Google keeps the event and just omits the conference (no error).
function resolveCreateMeetLink(config: Record<string, unknown>): boolean {
  return config.createMeetLink !== false;
}

// Friendly labels (calendar id → human name, e.g. "Dr. Ana"), captured when the operator picks
// calendars from the connected account. Best-effort: lets the model target a calendar by name and the
// tool description enumerate the allowed calendars. Missing labels fall back to the raw id.
function resolveCalendarLabels(
  config: Record<string, unknown>,
): Record<string, string> {
  const raw = config.calendarLabels;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

// Renders the allowed calendars for a tool description / error message: friendly name when known,
// otherwise the raw id.
function listAllowed(
  allowed: string[],
  labels: Record<string, string>,
): string {
  const list = allowed
    .map((id) => (labels[id] ? `"${labels[id]}"` : id))
    .join(", ");
  return `Allowed calendars: ${list} (pass calendarId by name or id).`;
}

// The allowed calendars as an XML block, appended at the END of a tool's description ONLY when several
// are allowed (with a single calendar it is auto-selected and never needs to be named). Each <calendar>
// carries the friendly name (when known) and/or the raw id — both are valid values for the calendarId
// arg. Empty ⇒ "" (no block).
function allowedCalendarsXml(
  allowed: string[],
  labels: Record<string, string>,
): string {
  if (allowed.length <= 1) return "";
  const els = allowed.map(
    (id) => `  <calendar${xmlAttr("name", labels[id])}${xmlAttr("id", id)}/>`,
  );
  return `<allowed_calendars>\n${els.join("\n")}\n</allowed_calendars>`;
}

// The configured appointment length as an XML element for calendar_check_availability: preset="true"
// with the pinned minutes when the operator fixed a duration, otherwise preset="false" (the model
// chooses per request via the slotDurationMinutes arg). Always non-empty.
function slotDurationXml(config: Record<string, unknown>): string {
  const pinned = configuredSlotDuration(config);
  return pinned === null
    ? `<slot_duration preset="false"/>`
    : `<slot_duration minutes="${pinned}" preset="true"/>`;
}

// Appends one or more XML context blocks to a tool's static description, at the very END, dropping any
// empty blocks. Keeps the static capability text and the live "current state" cleanly separated.
function withCalendarContext(base: string, ...blocks: string[]): string {
  const extra = blocks.filter((b) => b.trim());
  return extra.length ? `${base}\n\n${extra.join("\n")}` : base;
}

// Resolve which calendar a tool acts on from its optional arg + the allowlist. Fail-closed: no calendar
// configured is refused (never a silent "primary" default); an arg outside the allowlist is rejected;
// the arg may be a raw allowed id OR a known friendly name; with several allowed and no arg, the model
// is asked to choose.
function pickCalendarId(
  allowed: string[],
  labels: Record<string, string>,
  requested: string | undefined,
): { id: string } | { error: string } {
  if (allowed.length === 0) {
    return {
      error:
        "No calendar is configured for this integration. Pick at least one calendar in the integration settings before using the calendar tools.",
    };
  }
  const r = requested?.trim();
  if (r) {
    if (allowed.includes(r)) return { id: r };
    const lower = r.toLowerCase();
    const byLabel = allowed.find((id) => labels[id]?.toLowerCase() === lower);
    if (byLabel) return { id: byLabel };
    return {
      error: `Calendar "${r}" is not allowed for this integration. ${listAllowed(allowed, labels)}`,
    };
  }
  if (allowed.length === 1) return { id: allowed[0] as string };
  return {
    error: `Multiple calendars are configured; set calendarId. ${listAllowed(allowed, labels)}`,
  };
}

function resolveTimeZone(config: Record<string, unknown>): string {
  const v = config.timeZone;
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_TIME_ZONE;
}

// Slot sizing for availability, bound to config with sane clamps. The model MAY override the duration
// or granularity per call (e.g. a longer service); a missing/garbage value falls back to the config
// default, then the toolpack default.
const DEFAULT_SLOT_MINUTES = 30;
const DEFAULT_GRANULARITY_MINUTES = 15;
const MIN_GRAIN_MINUTES = 5;
const MAX_SLOT_MINUTES = 480;
const MAX_GRANULARITY_MINUTES = 240;
// Availability is queried one day at a time: cap the range so the (now unsampled) slot list stays small
// and the model pages through longer searches itself, a day per call.
const MAX_AVAILABILITY_RANGE_MS = 24 * 60 * 60 * 1000;

function clampMinutes(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.round(raw)
      : fallback;
  return Math.min(Math.max(n, min), max);
}

// The appointment length the config PINS, or null when the operator chose "let the AI decide" (no
// fixed value). When null, the model is expected to pass slotDurationMinutes per request; absent that,
// resolveSlotDuration falls back to the toolpack default.
function configuredSlotDuration(
  config: Record<string, unknown>,
): number | null {
  const v = config.slotDurationMinutes;
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.round(v)
    : null;
}

function resolveSlotDuration(
  config: Record<string, unknown>,
  override?: number,
): number {
  return clampMinutes(
    override ?? configuredSlotDuration(config),
    MIN_GRAIN_MINUTES,
    MAX_SLOT_MINUTES,
    DEFAULT_SLOT_MINUTES,
  );
}

function resolveSlotGranularity(
  config: Record<string, unknown>,
  override?: number,
): number {
  return clampMinutes(
    override ?? config.slotGranularityMinutes,
    MIN_GRAIN_MINUTES,
    MAX_GRANULARITY_MINUTES,
    DEFAULT_GRANULARITY_MINUTES,
  );
}

function resolveMinLead(config: Record<string, unknown>): number {
  return clampMinutes(config.minLeadMinutes, 0, 100_000, 0);
}

// The integration's chosen availability schedule (a BusinessHours id), bound to config. Null ⇒ the
// availability tool treats the schedule as "always on".
function resolveBusinessHoursId(
  config: Record<string, unknown>,
): string | null {
  const v = config.businessHoursId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The owning-contact stamp for THIS turn, from the trusted context. null when there is no contact in
// scope (playground / a path without a mirrored contact) → per-contact tools fail closed.
function contactStamp(ctx: ToolpackCtx): string | null {
  return ctx.contactDbId != null ? `${ctx.tenantId}:${ctx.contactDbId}` : null;
}

// Reads an event's owning-contact stamp from extendedProperties.private (null when absent — e.g. an
// event created manually by the clinic staff or before this isolation existed).
function eventStamp(ev: Record<string, unknown>): string | null {
  const ext = ev.extendedProperties;
  if (!ext || typeof ext !== "object") return null;
  const priv = (ext as Record<string, unknown>).private;
  if (!priv || typeof priv !== "object") return null;
  const v = (priv as Record<string, unknown>)[SECV4_CONTACT_KEY];
  return typeof v === "string" ? v : null;
}

// A Calendar start/end: a bare date (YYYY-MM-DD) is an all-day event; anything else is treated as a
// timed RFC3339 `dateTime` (carrying the config/default timeZone).
function toEventTime(value: string, timeZone: string): Record<string, string> {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };
  return { dateTime: v, timeZone };
}

// PATCH merges what we send, so a patch carrying only `dateTime` leaves the event's existing `date`
// in place — and Google rejects an event holding both (HTTP 400), which makes every all-day ⇄ timed
// conversion fail. Sending the opposite field as null clears it, so the patch replaces the time
// representation instead of mixing the two.
function toEventTimePatch(
  value: string,
  timeZone: string,
): Record<string, string | null> {
  const t = toEventTime(value, timeZone);
  return "date" in t ? { ...t, dateTime: null } : { ...t, date: null };
}

// The timezone's UTC offset (ms) at an instant, via Intl (Temporal is unavailable in Bun).
function tzOffsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - at;
}

// The UTC instant of local midnight for a YYYY-MM-DD in an IANA timezone (DST-correct: one
// refinement pass covers an offset shift between the UTC guess and the target instant).
function zonedMidnightMs(date: string, tz: string): number {
  const utcGuess = Date.parse(`${date}T00:00:00Z`);
  const first = utcGuess - tzOffsetMs(utcGuess, tz);
  return utcGuess - tzOffsetMs(first, tz);
}

// A blocking-calendar event as a busy window. Timed events parse as-is; an all-day `date` widens to
// local midnight in the integration timezone (Google's all-day end.date is already exclusive).
// Unparseable shapes → null (skipped defensively).
function blockingBusyWindow(
  ev: Record<string, unknown>,
  timeZone: string,
): { start: string; end: string } | null {
  const point = (t: unknown): number | null => {
    if (!t || typeof t !== "object") return null;
    const o = t as Record<string, unknown>;
    if (typeof o.dateTime === "string") {
      const ms = Date.parse(o.dateTime);
      return Number.isNaN(ms) ? null : ms;
    }
    if (typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) {
      return zonedMidnightMs(o.date, timeZone);
    }
    return null;
  };
  const start = point(ev.start);
  const end = point(ev.end);
  if (start === null || end === null || end <= start) return null;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

// Flattens a Calendar start/end object to a single string for the model (dateTime or all-day date).
function flattenTime(t: unknown): string | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (typeof o.dateTime === "string") return o.dateTime;
  if (typeof o.date === "string") return o.date;
  return null;
}

interface GcalResponse {
  status: number;
  json: unknown;
}

async function gcalFetch(
  path: string,
  init: { method: string; token: string; body?: unknown },
  ctx: ToolpackCtx,
): Promise<GcalResponse> {
  const url = `${GCAL_ORIGIN}${path}`;
  const assertSafe = ctx.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(url);
  const doFetch = ctx.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        "Content-Type": "application/json",
        "User-Agent": "agents",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
      signal: ctrl.signal,
    });
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body → leave json null; the caller surfaces a generic error
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// Resolves the bearer (fresh access token for a google_oauth credential) once per tool call. Null when
// the integration has no connected credential → a fail-closed message instead of an unauthenticated call.
async function resolveToken(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): Promise<string | null> {
  return sel.credentialRef
    ? await ctx.resolveCredential(sel.credentialRef)
    : null;
}

const NOT_CONNECTED =
  "Google Calendar is not connected for this integration. Connect a Google account (Calendar scope) in the integration's credential.";

const NO_CONTACT =
  "This calendar action is only available inside a customer conversation (each customer only ever sees their own appointments). There is no contact in scope right now.";

const FOREIGN_EVENT =
  "That appointment is not associated with this customer, so it cannot be read or changed here.";

const CALENDAR_ID_DESC =
  "Which calendar to act on. Optional; required only when the integration allows several calendars. Pass an allowed calendar's name or id.";

function projectEvent(ev: Record<string, unknown>) {
  return {
    id: typeof ev.id === "string" ? ev.id : null,
    summary: typeof ev.summary === "string" ? ev.summary : null,
    start: flattenTime(ev.start),
    end: flattenTime(ev.end),
    htmlLink: typeof ev.htmlLink === "string" ? ev.htmlLink : undefined,
    // NOTE: the Meet room (hangoutLink) — THE link to hand the customer; htmlLink is only the event's
    // calendar page, useless to a lead without access to the calendar.
    meetLink: typeof ev.hangoutLink === "string" ? ev.hangoutLink : undefined,
  };
}

// Tool input schemas (single source for both the runtime tool and the UI arg specs). Risk is
// declared in GCAL_TOOL_SPECS: reads (list/freeBusy) are low, writing events is medium.
const LIST_EVENTS_SCHEMA = z.object({
  timeMin: z
    .string()
    .optional()
    .describe("Range start, ISO 8601 (e.g. 2026-06-20T00:00:00-03:00)."),
  timeMax: z.string().optional().describe("Range end, ISO 8601."),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Max appointments to return (default 10, max ${MAX_LIST_RESULTS}).`,
    ),
  calendarId: z.string().optional().describe(CALENDAR_ID_DESC),
});

const CHECK_AVAILABILITY_SCHEMA = z.object({
  timeMin: z
    .string()
    .describe(
      "Range start to search within, ISO 8601. Search at most 24h per call.",
    ),
  timeMax: z
    .string()
    .describe(
      "Range end to search within, ISO 8601. Must be within 24h of timeMin.",
    ),
  slotDurationMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Appointment length in minutes. Optional; defaults to the integration's setting (e.g. 30 or 60).",
    ),
  granularityMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Spacing between candidate start times, in minutes. Optional; defaults to the integration's setting (e.g. 15 ⇒ 09:00 and 09:15 are both offered).",
    ),
  calendarId: z.string().optional().describe(CALENDAR_ID_DESC),
});

const CREATE_EVENT_SCHEMA = z.object({
  summary: z.string().min(1).describe("Event title."),
  start: z
    .string()
    .min(1)
    .describe("Start, ISO 8601 datetime (timed) or YYYY-MM-DD (all-day)."),
  end: z.string().min(1).describe("End, same format as start."),
  description: z.string().max(2000).optional().describe("Event details."),
  calendarId: z.string().optional().describe(CALENDAR_ID_DESC),
});

const UPDATE_EVENT_SCHEMA = z.object({
  eventId: z.string().min(1).describe("The event id to update."),
  summary: z.string().min(1).optional().describe("New title."),
  start: z.string().optional().describe("New start (ISO 8601 or date)."),
  end: z.string().optional().describe("New end (ISO 8601 or date)."),
  description: z.string().max(2000).optional().describe("New details."),
  calendarId: z.string().optional().describe(CALENDAR_ID_DESC),
});

const CANCEL_EVENT_SCHEMA = z.object({
  eventId: z
    .string()
    .min(1)
    .describe("The event id to cancel (e.g. from calendar_list_events)."),
  calendarId: z.string().optional().describe(CALENDAR_ID_DESC),
});

const CONFIRM_APPOINTMENT_SCHEMA = z.object({
  eventId: z
    .string()
    .min(1)
    .describe(
      "The event id to mark as confirmed (e.g. from calendar_list_events).",
    ),
  calendarId: z.string().optional().describe(CALENDAR_ID_DESC),
});

const GCAL_TOOL_SPECS: ToolSpec[] = [
  { name: "calendar_list_events", risk: "low", schema: LIST_EVENTS_SCHEMA },
  {
    name: "calendar_check_availability",
    risk: "low",
    schema: CHECK_AVAILABILITY_SCHEMA,
  },
  {
    name: "calendar_create_event",
    risk: "medium",
    schema: CREATE_EVENT_SCHEMA,
  },
  {
    name: "calendar_update_event",
    risk: "medium",
    schema: UPDATE_EVENT_SCHEMA,
  },
  {
    name: "calendar_cancel_event",
    risk: "medium",
    schema: CANCEL_EVENT_SCHEMA,
  },
  {
    name: "calendar_confirm_appointment",
    risk: "medium",
    schema: CONFIRM_APPOINTMENT_SCHEMA,
  },
];

function buildListEventsTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const allowed = resolveAllowedCalendarIds(sel.config);
  const labels = resolveCalendarLabels(sel.config);
  return tool(
    async (input: {
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      calendarId?: string;
    }) => {
      const stamp = contactStamp(ctx);
      if (!stamp) return NO_CONTACT;
      const token = await resolveToken(sel, ctx);
      if (!token) return NOT_CONNECTED;
      const pick = pickCalendarId(allowed, labels, input.calendarId);
      if ("error" in pick) return pick.error;
      const calendarId = pick.id;
      const params = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(
          Math.min(Math.max(input.maxResults ?? 10, 1), MAX_LIST_RESULTS),
        ),
        // Server-side fence: only events stamped for THIS customer. The model has no field to widen it.
        privateExtendedProperty: `${SECV4_CONTACT_KEY}=${stamp}`,
      });
      if (input.timeMin) params.set("timeMin", input.timeMin);
      if (input.timeMax) params.set("timeMax", input.timeMax);
      let res: GcalResponse;
      try {
        res = await gcalFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
          { method: "GET", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: list events request failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (res.status < 200 || res.status >= 300) {
        return `Google Calendar returned HTTP ${res.status}.`;
      }
      const data = (res.json ?? {}) as Record<string, unknown>;
      const items = Array.isArray(data.items) ? data.items : [];
      // Defense in depth: re-verify each event's stamp client-side, so a filter miss can never leak
      // another customer's appointment.
      const owned = items
        .map((e) => (e ?? {}) as Record<string, unknown>)
        .filter((e) => eventStamp(e) === stamp);
      const dropped = items.length - owned.length;
      if (dropped > 0) {
        // The server-side privateExtendedProperty fence should have excluded these already; a non-zero
        // count means the fence is leaking and only this client-side re-verify is keeping it isolated.
        logger.warn(
          { dropped, returned: items.length, calendarId },
          "gcal: list re-verify dropped events the server-side contact fence returned",
        );
      }
      return JSON.stringify(owned.map(projectEvent));
    },
    {
      name: "calendar_list_events",
      description: withCalendarContext(
        `List THIS customer's own appointments on the calendar in a time range (each customer only ever sees their own). Holidays, closures, staff events and other customers' bookings are NEVER visible here, so an empty result does NOT mean the calendar is free; use calendar_check_availability to know what is actually bookable. Returns each appointment's id, summary, start and end. Use ISO 8601 timestamps (with offset) for the range.`,
        allowedCalendarsXml(allowed, labels),
      ),
      schema: LIST_EVENTS_SCHEMA,
    },
  );
}

function buildCheckAvailabilityTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const allowed = resolveAllowedCalendarIds(sel.config);
  const labels = resolveCalendarLabels(sel.config);
  const timeZone = resolveTimeZone(sel.config);
  const businessHoursId = resolveBusinessHoursId(sel.config);
  const minLeadMinutes = resolveMinLead(sel.config);
  const blockingIds = resolveBlockingCalendarIds(sel.config);
  return tool(
    async (input: {
      timeMin: string;
      timeMax: string;
      slotDurationMinutes?: number;
      granularityMinutes?: number;
      calendarId?: string;
    }) => {
      const minMs = Date.parse(input.timeMin);
      const maxMs = Date.parse(input.timeMax);
      if (Number.isNaN(minMs) || Number.isNaN(maxMs) || maxMs <= minMs) {
        return "Invalid range: provide ISO 8601 timeMin and timeMax, with timeMax after timeMin.";
      }
      if (maxMs - minMs > MAX_AVAILABILITY_RANGE_MS) {
        return "Please search at most 24 hours at a time. Narrow the range to a single day and call again for other days.";
      }
      const token = await resolveToken(sel, ctx);
      if (!token) return NOT_CONNECTED;
      const pick = pickCalendarId(allowed, labels, input.calendarId);
      if ("error" in pick) return pick.error;
      const calendarId = pick.id;
      const body = {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        timeZone,
        items: [{ id: calendarId }],
      };
      let res: GcalResponse;
      try {
        res = await gcalFetch(
          "/freeBusy",
          { method: "POST", token, body },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: freeBusy request failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (res.status < 200 || res.status >= 300) {
        return `Google Calendar returned HTTP ${res.status}.`;
      }
      const data = (res.json ?? {}) as Record<string, unknown>;
      const calendars = (data.calendars ?? {}) as Record<string, unknown>;
      const entry = (calendars[calendarId] ?? {}) as Record<string, unknown>;
      const busy = (Array.isArray(entry.busy) ? entry.busy : [])
        .map((b) => (b ?? {}) as Record<string, unknown>)
        .filter((b) => typeof b.start === "string" && typeof b.end === "string")
        .map((b) => ({ start: b.start as string, end: b.end as string }));
      // Blocking calendars (holidays, closures) count as busy too, read via events.list, NOT
      // freeBusy: all-day events (the typical holiday shape) default to transparency "transparent"
      // ("Free") and freeBusy silently ignores them, which is exactly the calendar the operator
      // expects to block. Only start/end are requested (no titles or attendees reach the model).
      // Fail-closed: a blocking calendar we cannot read could be hiding a closure, so refusing
      // beats offering a slot the operator explicitly blocked.
      const blocking = blockingIds.filter((id) => id !== calendarId);
      if (blocking.length > MAX_BLOCKING_CALENDARS) {
        return `Too many blocking calendars are configured (${blocking.length}; the limit is ${MAX_BLOCKING_CALENDARS}), so availability cannot be verified. Reduce the blocking calendars in the integration settings.`;
      }
      if (blocking.length > 0) {
        const evParams = new URLSearchParams({
          singleEvents: "true",
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          maxResults: "50",
          fields: "items(start,end),nextPageToken",
        });
        let blockingRes: GcalResponse[];
        try {
          blockingRes = await Promise.all(
            blocking.map((id) =>
              gcalFetch(
                `/calendars/${encodeURIComponent(id)}/events?${evParams.toString()}`,
                { method: "GET", token },
                ctx,
              ),
            ),
          );
        } catch (err) {
          logger.warn({ err }, "gcal: blocking calendars request failed");
          return "Failed to read a blocking calendar (holidays/closures), so availability cannot be verified right now. Try again shortly.";
        }
        for (const r of blockingRes) {
          if (r.status < 200 || r.status >= 300) {
            return `Google Calendar returned HTTP ${r.status} for a blocking calendar, so availability cannot be verified right now.`;
          }
          const evData = (r.json ?? {}) as Record<string, unknown>;
          // A nextPageToken means the window holds more events than the cap covers; treating the
          // partial page as complete could offer a slot the operator explicitly blocked.
          if (typeof evData.nextPageToken === "string") {
            return "A blocking calendar has more events in this range than can be checked at once, so availability cannot be verified right now. Try a narrower range.";
          }
          const items = Array.isArray(evData.items) ? evData.items : [];
          for (const ev of items) {
            const w = blockingBusyWindow(
              (ev ?? {}) as Record<string, unknown>,
              timeZone,
            );
            if (w) busy.push(w);
          }
        }
      }
      // The service hours bounding bookable slots: the integration's chosen BusinessHours (windows +
      // its own timezone). Unset/missing ⇒ no time-of-day filter ("always on"); we then fall back to
      // the integration's display timezone for the slot labels.
      const schedule =
        businessHoursId && ctx.resolveBusinessHours
          ? await ctx.resolveBusinessHours(businessHoursId)
          : null;
      const slots = computeAvailableSlots({
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        now: new Date(),
        scheduleWindows: schedule?.windows ?? [],
        scheduleTz: schedule?.timezone ?? timeZone,
        busy,
        slotMinutes: resolveSlotDuration(sel.config, input.slotDurationMinutes),
        granularityMinutes: resolveSlotGranularity(
          sel.config,
          input.granularityMinutes,
        ),
        minLeadMinutes,
      });
      // A list of bookable start times (start/end ISO + a human label). Empty ⇒ nothing free in range.
      return JSON.stringify({
        slots,
        timeZone: schedule?.timezone ?? timeZone,
      });
    },
    {
      name: "calendar_check_availability",
      description: withCalendarContext(
        `Return ALL bookable appointment start times within a range, already honoring the service hours, existing bookings and any operator-designated blocking calendars such as holidays or closures (no appointment details are exposed). Each slot has start, end and a human-readable label. Offer these to the customer and confirm one before creating the appointment. Pass ISO 8601 timestamps for the range, and search AT MOST 24 hours per call (one day at a time — call again for other days). The configured appointment length is shown in \`<slot_duration>\` below — when preset="false", choose it yourself per request and pass slotDurationMinutes (e.g. 30 for a standard appointment, 60 for a longer one); when preset="true", pass slotDurationMinutes only to override it.`,
        slotDurationXml(sel.config),
        allowedCalendarsXml(allowed, labels),
      ),
      schema: CHECK_AVAILABILITY_SCHEMA,
    },
  );
}

function buildCreateEventTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const allowed = resolveAllowedCalendarIds(sel.config);
  const labels = resolveCalendarLabels(sel.config);
  const timeZone = resolveTimeZone(sel.config);
  const meetEnabled = resolveCreateMeetLink(sel.config);
  return tool(
    async (input: {
      summary: string;
      start: string;
      end: string;
      description?: string;
      calendarId?: string;
    }) => {
      const stamp = contactStamp(ctx);
      if (!stamp) return NO_CONTACT;
      const token = await resolveToken(sel, ctx);
      if (!token) return NOT_CONNECTED;
      const pick = pickCalendarId(allowed, labels, input.calendarId);
      if ("error" in pick) return pick.error;
      const calendarId = pick.id;
      const body: Record<string, unknown> = {
        summary: input.summary,
        start: toEventTime(input.start, timeZone),
        end: toEventTime(input.end, timeZone),
        ...(input.description ? { description: input.description } : {}),
        // Owner stamp injected from context, never from the model: locks this appointment to the contact.
        extendedProperties: { private: { [SECV4_CONTACT_KEY]: stamp } },
        // NOTE: a Meet room for the appointment. requestId MUST be unique per event: Google returns the
        // SAME room for a reused id, which would put different leads in one meeting.
        ...(meetEnabled
          ? {
              conferenceData: {
                createRequest: {
                  requestId: crypto.randomUUID(),
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            }
          : {}),
      };
      let res: GcalResponse;
      try {
        res = await gcalFetch(
          // NOTE: without conferenceDataVersion=1 the API IGNORES conferenceData in silence — no error,
          // no room. Easy to lose in a refactor; pinned by tests.
          `/calendars/${encodeURIComponent(calendarId)}/events${meetEnabled ? "?conferenceDataVersion=1" : ""}`,
          { method: "POST", token, body },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: create event request failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (res.status < 200 || res.status >= 300) {
        return `Google Calendar rejected the event (HTTP ${res.status}).`;
      }
      let data = (res.json ?? {}) as Record<string, unknown>;
      if (typeof data.id !== "string") {
        return "Google Calendar returned an unexpected response.";
      }
      const eventId = data.id;
      // NOTE: room creation is usually synchronous, but the API may answer with the createRequest still
      // pending and no hangoutLink; one cheap re-read closes that gap (no polling — if it is STILL
      // pending, the reply simply carries no meetLink and the event stands).
      if (meetEnabled && typeof data.hangoutLink !== "string") {
        try {
          const re = await gcalFetch(
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
            { method: "GET", token },
            ctx,
          );
          const rec = (re.json ?? {}) as Record<string, unknown>;
          if (
            re.status >= 200 &&
            re.status < 300 &&
            typeof rec.hangoutLink === "string"
          ) {
            data = rec;
          }
        } catch (err) {
          logger.warn({ err }, "gcal: meet-link re-read failed");
        }
      }
      // Arm deterministic reminders for the new appointment (best-effort; no-op when the Calendar
      // integration has reminders disabled / on the playground). The policy (offsets/confirmation) is
      // read from THIS integration's config. startISO from the canonical response, then the input.
      const startISO = flattenTime(data.start) ?? input.start;
      const apptCfg = readAppointmentReminderConfig(sel.config);
      if (apptCfg.enabled && ctx.scheduleAppointmentReminders && startISO) {
        await ctx.scheduleAppointmentReminders({
          eventId,
          calendarId,
          startISO,
          credentialRef: sel.credentialRef,
          offsetsHours: apptCfg.offsetsHours,
          askConfirmationOnLast: apptCfg.askConfirmationOnLast,
        });
      }
      return JSON.stringify(projectEvent(data));
    },
    {
      name: "calendar_create_event",
      description: withCalendarContext(
        `Create an appointment for THIS customer on the calendar (it is automatically tagged to this customer, so only they can later see or change it). Provide a summary plus start and end. Use ISO 8601 with an offset for timed events (e.g. 2026-06-20T14:00:00-03:00) or a bare date (2026-06-20) for an all-day event. Returns the created appointment's id and links${meetEnabled ? "; share meetLink (the Google Meet room) with the customer — htmlLink is only the calendar page" : ""}.`,
        allowedCalendarsXml(allowed, labels),
      ),
      schema: CREATE_EVENT_SCHEMA,
    },
  );
}

function buildUpdateEventTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const allowed = resolveAllowedCalendarIds(sel.config);
  const labels = resolveCalendarLabels(sel.config);
  const timeZone = resolveTimeZone(sel.config);
  return tool(
    async (input: {
      eventId: string;
      summary?: string;
      start?: string;
      end?: string;
      description?: string;
      calendarId?: string;
    }) => {
      const stamp = contactStamp(ctx);
      if (!stamp) return NO_CONTACT;
      const token = await resolveToken(sel, ctx);
      if (!token) return NOT_CONNECTED;
      const pick = pickCalendarId(allowed, labels, input.calendarId);
      if ("error" in pick) return pick.error;
      const calendarId = pick.id;
      const body: Record<string, unknown> = {};
      if (input.summary !== undefined) body.summary = input.summary;
      if (input.description !== undefined) body.description = input.description;
      if (input.start !== undefined)
        body.start = toEventTimePatch(input.start, timeZone);
      if (input.end !== undefined)
        body.end = toEventTimePatch(input.end, timeZone);
      if (Object.keys(body).length === 0) {
        return "No fields provided. Set at least one of summary, start, end or description.";
      }
      // Ownership gate: re-fetch the event and refuse unless it carries THIS customer's stamp, so the
      // agent can never edit another customer's (or a staff-created) appointment by guessing an id.
      let owner: GcalResponse;
      try {
        owner = await gcalFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}?fields=extendedProperties`,
          { method: "GET", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: update ownership check failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (owner.status === 404) return FOREIGN_EVENT;
      if (owner.status < 200 || owner.status >= 300) {
        return `Google Calendar returned HTTP ${owner.status}.`;
      }
      const ownerEv = (owner.json ?? {}) as Record<string, unknown>;
      if (eventStamp(ownerEv) !== stamp) return FOREIGN_EVENT;
      let res: GcalResponse;
      try {
        res = await gcalFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`,
          { method: "PATCH", token, body },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: update event request failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (res.status < 200 || res.status >= 300) {
        return `Google Calendar rejected the update (HTTP ${res.status}).`;
      }
      const data = (res.json ?? {}) as Record<string, unknown>;
      // A reschedule (start changed) re-arms reminders against the new time: cancel the old ones, then
      // re-enqueue (best-effort). Cancel always runs so stale reminders clear even if reminders are now
      // off; re-arm only when scheduling is wired (enabled + real conversation).
      if (input.start !== undefined) {
        await ctx.cancelAppointmentReminders?.(input.eventId);
        const newStartISO = flattenTime(data.start) ?? input.start;
        const apptCfg = readAppointmentReminderConfig(sel.config);
        if (
          apptCfg.enabled &&
          newStartISO &&
          ctx.scheduleAppointmentReminders
        ) {
          await ctx.scheduleAppointmentReminders({
            eventId: input.eventId,
            calendarId,
            startISO: newStartISO,
            credentialRef: sel.credentialRef,
            offsetsHours: apptCfg.offsetsHours,
            askConfirmationOnLast: apptCfg.askConfirmationOnLast,
          });
        }
      }
      return JSON.stringify(projectEvent(data));
    },
    {
      name: "calendar_update_event",
      description: withCalendarContext(
        `Reschedule or edit THIS customer's appointment (by its id, e.g. from calendar_list_events). Only an appointment belonging to this customer can be changed. Provide ONLY the fields to change. Dates use the same ISO 8601 / all-day format as create.`,
        allowedCalendarsXml(allowed, labels),
      ),
      schema: UPDATE_EVENT_SCHEMA,
    },
  );
}

function buildCancelEventTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const allowed = resolveAllowedCalendarIds(sel.config);
  const labels = resolveCalendarLabels(sel.config);
  return tool(
    async (input: { eventId: string; calendarId?: string }) => {
      const stamp = contactStamp(ctx);
      if (!stamp) return NO_CONTACT;
      const token = await resolveToken(sel, ctx);
      if (!token) return NOT_CONNECTED;
      const pick = pickCalendarId(allowed, labels, input.calendarId);
      if ("error" in pick) return pick.error;
      const calendarId = pick.id;
      // Ownership gate (same as update): re-fetch and refuse unless the event carries THIS customer's
      // stamp, so the agent can never cancel another customer's (or a staff-created) appointment.
      let owner: GcalResponse;
      try {
        owner = await gcalFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}?fields=extendedProperties`,
          { method: "GET", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: cancel ownership check failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (owner.status === 404) return FOREIGN_EVENT;
      if (owner.status < 200 || owner.status >= 300) {
        return `Google Calendar returned HTTP ${owner.status}.`;
      }
      const ownerEv = (owner.json ?? {}) as Record<string, unknown>;
      if (eventStamp(ownerEv) !== stamp) return FOREIGN_EVENT;
      let res: GcalResponse;
      try {
        res = await gcalFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`,
          { method: "DELETE", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: cancel event request failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      // 204 No Content is the success shape; 410 Gone means it was already cancelled (idempotent).
      if (res.status === 410) return "The appointment was already cancelled.";
      if (res.status !== 204 && (res.status < 200 || res.status >= 300)) {
        return `Google Calendar rejected the cancellation (HTTP ${res.status}).`;
      }
      // Drop any pending reminders for this appointment (best-effort).
      await ctx.cancelAppointmentReminders?.(input.eventId);
      return "The appointment was cancelled.";
    },
    {
      name: "calendar_cancel_event",
      description: withCalendarContext(
        `Cancel (delete) THIS customer's appointment by its id (e.g. from calendar_list_events). Only an appointment belonging to this customer can be cancelled.`,
        allowedCalendarsXml(allowed, labels),
      ),
      schema: CANCEL_EVENT_SCHEMA,
    },
  );
}

function buildConfirmAppointmentTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const allowed = resolveAllowedCalendarIds(sel.config);
  const labels = resolveCalendarLabels(sel.config);
  return tool(
    async (input: { eventId: string; calendarId?: string }) => {
      const stamp = contactStamp(ctx);
      if (!stamp) return NO_CONTACT;
      const token = await resolveToken(sel, ctx);
      if (!token) return NOT_CONNECTED;
      const pick = pickCalendarId(allowed, labels, input.calendarId);
      if ("error" in pick) return pick.error;
      const calendarId = pick.id;
      // Ownership gate + read the current title so [CONFIRMADO] is prefixed idempotently.
      let owner: GcalResponse;
      try {
        owner = await gcalFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}?fields=extendedProperties,summary`,
          { method: "GET", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: confirm ownership check failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (owner.status === 404) return FOREIGN_EVENT;
      if (owner.status < 200 || owner.status >= 300) {
        return `Google Calendar returned HTTP ${owner.status}.`;
      }
      const ownerEv = (owner.json ?? {}) as Record<string, unknown>;
      if (eventStamp(ownerEv) !== stamp) return FOREIGN_EVENT;
      const currentSummary =
        typeof ownerEv.summary === "string" ? ownerEv.summary : "";
      const newSummary = currentSummary.startsWith(CONFIRMED_PREFIX)
        ? currentSummary
        : `${CONFIRMED_PREFIX}${currentSummary}`;
      const body: Record<string, unknown> = {
        summary: newSummary,
        // Re-assert the contact stamp alongside the confirmation marker: a PATCH on the private map must
        // never drop the isolation stamp. Both keys injected from code, never the model; neither is
        // surfaced in projectEvent.
        extendedProperties: {
          private: {
            [SECV4_CONTACT_KEY]: stamp,
            [SECV4_CONFIRMED_KEY]: new Date().toISOString(),
          },
        },
      };
      let res: GcalResponse;
      try {
        res = await gcalFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`,
          { method: "PATCH", token, body },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "gcal: confirm event request failed");
        return "Failed to reach Google Calendar. Try again shortly.";
      }
      if (res.status < 200 || res.status >= 300) {
        return `Google Calendar rejected the confirmation (HTTP ${res.status}).`;
      }
      return "The appointment was marked as confirmed.";
    },
    {
      name: "calendar_confirm_appointment",
      description: withCalendarContext(
        `Mark THIS customer's appointment as CONFIRMED after they confirm they will attend (by its id, e.g. from calendar_list_events). Prefixes the event title with [CONFIRMADO] and records the confirmation on the event. Only an appointment belonging to this customer can be confirmed.`,
        allowedCalendarsXml(allowed, labels),
      ),
      schema: CONFIRM_APPOINTMENT_SCHEMA,
    },
  );
}

const TOOL_BUILDERS: Record<
  string,
  (sel: IntegrationSelection, ctx: ToolpackCtx) => StructuredToolInterface
> = {
  calendar_list_events: buildListEventsTool,
  calendar_check_availability: buildCheckAvailabilityTool,
  calendar_create_event: buildCreateEventTool,
  calendar_update_event: buildUpdateEventTool,
  calendar_cancel_event: buildCancelEventTool,
  calendar_confirm_appointment: buildConfirmAppointmentTool,
};

export const googleCalendarToolpack: Toolpack = {
  catalogType: "GOOGLE_CALENDAR",
  toolSpecs: GCAL_TOOL_SPECS,
  build(sel, ctx) {
    const out: StructuredToolInterface[] = [];
    for (const name of sel.enabledTools) {
      const builder = TOOL_BUILDERS[name];
      if (builder) out.push(builder(sel, ctx));
    }
    return out;
  },
};

registerToolpack(googleCalendarToolpack);
