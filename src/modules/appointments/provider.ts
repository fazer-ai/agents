// WHICH SYSTEM OWNS A BOOKING. A booking is either a Google Calendar event or one an operator's tool
// declared, and the owner stored beside the id decides two things. IDENTITY: the record and its
// reminder jobs are keyed by (tenant, provider, external id), since two operator systems can both
// answer "42". OPERABILITY: only a Google appointment may be pointed at the Calendar tools, and the
// per-turn context block reads a record (no credential), so the answer has to be stored.
// Pure: no I/O, no clock.

// The DEFAULT of the column, so rows written before providers existed stay Google bookings.
export const GOOGLE_CALENDAR_PROVIDER = "google_calendar";

// The provider of a declared appointment whose declaration does not name one. An operator with a
// single booking system never has to type anything; one with two names them, and the names are what
// keeps their id spaces apart.
export const DECLARED_PROVIDER = "declared";

// A slug an operator may write: lowercase, short, and shaped like a name rather than a sentence,
// because it goes into a scheduler dedupe key and into a unique index.
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// Null for anything unusable, INCLUDING the Google name: a declaration claiming to be
// `google_calendar` would put an operator's id into Google's id space, where the context block
// would then tell the model to cancel it with calendar_cancel_event.
export function readProviderSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!PROVIDER_SLUG.test(s)) return null;
  return s === GOOGLE_CALENDAR_PROVIDER ? null : s;
}

// The id the reminder jobs of an appointment are keyed by (`reminder:<scope>:<offset>`).
// Google keeps the BARE event id: already-armed reminders are keyed that way, and a Calendar id
// (base32hex plus `_`) holds neither `:` nor `%`. Every other id is percent-encoded because keys are
// retired by PREFIX `reminder:<scope>:`, and an id `foo` must not match the reminders of `foo:bar`.
export function reminderScopeId(provider: string, externalId: string): string {
  return provider === GOOGLE_CALENDAR_PROVIDER
    ? externalId
    : `${provider}/${encodeURIComponent(externalId)}`;
}
