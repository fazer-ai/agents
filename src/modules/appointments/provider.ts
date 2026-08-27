// WHICH SYSTEM OWNS A BOOKING, and the two questions that answer used to be silently assumed.
//
// Until issue #352 an appointment record was a Google Calendar event and nothing else. That made
// two defaults invisible because they were always right: the event id alone identified the booking,
// and the Calendar tools could always reach it. A tool definition can now declare that its own
// response describes an appointment, and both defaults break at once — two operator systems hand
// back the same locally-scoped id ("42"), and neither booking is reachable with
// calendar_update_event.
//
// So the owner is stored beside the id, and it decides:
//
//   - IDENTITY. The record's key is (tenant, provider, external id), never the id alone, and the
//     reminder jobs are keyed the same way.
//   - OPERABILITY. Only a Google appointment may be pointed at the Calendar tools. The reminder
//     nudge already asked this question and answered it from `credentialRef` (null ⇒ no Google to
//     ask); the per-turn context block reads a RECORD, which carries no credential, so it needs the
//     answer stored. Same question, one vocabulary.
//
// Pure: no I/O, no clock.

// The provider of every appointment written before this existed, and the DEFAULT of the column, so
// the rows the backfill wrote keep the identity and the operability they were written with.
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
//
// Google keeps the BARE event id, deliberately: every reminder armed before providers existed is
// keyed that way, and a cancel that started prefixing them would look for a key nothing wrote and
// leave a real customer reminder firing for an appointment that no longer stands. It is also the
// only provider whose ids are known not to need the encoding below — a Calendar event id is
// base32hex plus `_`, so it can hold neither `:` nor `%`.
//
// EVERY OTHER PROVIDER'S ID IS PERCENT-ENCODED, and the reason is that the key is read back by
// PREFIX. Retiring an appointment's reminders matches `reminder:<scope>:`, so an id that itself
// contains the delimiter puts a second appointment inside the first one's prefix: with ids `foo` and
// `foo:bar`, `reminder:p/foo:` matches `reminder:p/foo:bar:24`, and booking or cancelling `foo`
// silently tombstones the reminders of `foo:bar`. A declared id is whatever the operator's system
// answers with — `clinic:123` is an ordinary shape — so the delimiter has to be one the id cannot
// contain. The LIKE escaping in the tombstone statement already covers the `%` this introduces.
export function reminderScopeId(provider: string, externalId: string): string {
  return provider === GOOGLE_CALENDAR_PROVIDER
    ? externalId
    : `${provider}/${encodeURIComponent(externalId)}`;
}
