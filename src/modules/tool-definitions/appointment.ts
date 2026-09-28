// What an operator-authored HTTP tool declares about the appointment its response describes, and how
// that declaration is read off a response body. Pure: no I/O, no clock.
//
// A DECLARATION, not a tool the agent calls: the Calendar toolpack registers a booking from its own
// code, and an operator's tool can only match that through its definition. A separate native tool is
// a call the model can omit, silently losing the follow-up pause. Reminders are OPT-IN, the record is
// not: an appointment that arms no reminder is still a complete record.

import { clipText, makeStorable, unstorableCodePoints } from "@/lib/text";
import {
  DECLARED_PROVIDER,
  readProviderSlug,
} from "@/modules/appointments/provider";
import { normalizeOffsets } from "@/modules/appointments/settings";
import {
  collectLeaves,
  isUsablePath,
  type SampleLeaf,
  walkPath,
} from "@/modules/tool-definitions/json-path";

export interface AppointmentDeclaration {
  // "book": the response describes an appointment that now stands. "cancel": it describes one that
  // no longer does. Two actions rather than two declarations, because they address the same booking
  // by the same id and an operator who has one tool almost always has the other.
  action: "book" | "cancel";
  // The booking system these ids belong to. Half of the appointment's identity: an id is only unique
  // WITHIN the system that issued it, and two operator systems that both count from 1 would
  // otherwise overwrite each other's bookings. Defaulted rather than required, because an operator
  // with a single booking system has nothing to disambiguate; one with two names them, and the book
  // and cancel tools of the same system have to carry the SAME name or the cancel reaches no record.
  provider: string;
  // Where the booking's own id is in the response. It becomes the record's external id, so it has to
  // be the id the CANCEL tool will answer with too.
  idPath: string;
  // Where the start is. Required for "book" and meaningless for "cancel". Read as the string the
  // owning system sent, offset included: it is what the customer is told out loud.
  startPath?: string;
  summaryPath?: string;
  // Hours before the start to remind, e.g. [24, 1]. Absent or empty arms nothing. Normalized by the
  // same clamp the per-agent reminder config uses, so a declaration cannot ask for more jobs per
  // booking than the settings page can.
  reminderOffsetsHours?: number[];
  askConfirmationOnLast?: boolean;
}

// Null for anything this cannot act on, and that is the fail-safe direction: a declaration the
// reader cannot make sense of registers NOTHING, rather than registering something half-specified
// that the four readers of an appointment would then disagree about.
export function readAppointmentDeclaration(
  raw: unknown,
): AppointmentDeclaration | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bag = raw as Record<string, unknown>;
  const action = bag.action;
  if (action !== "book" && action !== "cancel") return null;
  if (!isUsablePath(bag.idPath)) return null;
  // OMITTED and SUPPLIED-BUT-INVALID are different answers, and collapsing them is what let a typo
  // through. `readProviderSlug` says null for both a malformed slug and for the reserved
  // `google_calendar`, so `?? DECLARED_PROVIDER` silently moved an explicitly named booking system
  // into the shared namespace: the book tool saved as `declared` while its paired cancel tool, spelled
  // correctly, saved as `feegow`, and the cancellation then never found the record. The form has
  // refused this since the third round; this is the same refusal on the REST/MCP path, which is where
  // a declaration can also be written.
  if (bag.provider !== undefined && bag.provider !== null) {
    if (readProviderSlug(bag.provider) === null) return null;
  }
  const provider = readProviderSlug(bag.provider) ?? DECLARED_PROVIDER;
  if (action === "cancel") return { action, provider, idPath: bag.idPath };
  if (!isUsablePath(bag.startPath)) return null;
  // The SAME normalization the per-agent reminder config runs: clamped to [1, 8760] hours, de-duped,
  // sorted far-to-near and capped at five. Every offset becomes one scheduler job on every booking,
  // so an API-authored declaration listing a thousand of them would turn one tool call into a
  // thousand inserts. Reusing the function rather than re-deriving the bound is the point: two
  // answers to "how many reminders may an appointment have?" is how the cap on one path stops being
  // a cap at all.
  const offsets = normalizeOffsets(bag.reminderOffsetsHours);
  return {
    action,
    provider,
    idPath: bag.idPath,
    startPath: bag.startPath,
    ...(isUsablePath(bag.summaryPath) ? { summaryPath: bag.summaryPath } : {}),
    ...(offsets.length > 0
      ? {
          reminderOffsetsHours: offsets,
          askConfirmationOnLast: bag.askConfirmationOnLast === true,
        }
      : {}),
  };
}

// What an appointment path is allowed to END on. Narrower than the template reader's rule
// (`response-template.ts`) on purpose, and the difference is not taste: an id may not be the empty
// string and may not be a boolean, because the value is IDENTITY that a later cancel has to answer
// with. The walk, the grammar and the picker are shared (`json-path.ts`); only this is local.
function readScalar(cur: unknown): string | undefined {
  if (typeof cur === "string") return cur || undefined;
  if (typeof cur === "number" && Number.isFinite(cur)) {
    // A number past 2^53 was ALREADY rounded, by JSON.parse, before this function was called: a
    // 64-bit booking id like 9007199254740993 arrives here as ...992, and String() would mint an id
    // the operator's system never issued — one that can land on the booking NEXT to it, so a later
    // cancel retires the wrong customer's appointment. The digits are unrecoverable at this point,
    // so the path is reported as unresolved instead, which is the channel that tells the operator to
    // point at the string id an API returning ids that large almost always returns beside it.
    return Math.abs(cur) > Number.MAX_SAFE_INTEGER ? undefined : String(cur);
  }
  return undefined;
}

// Walk a dotted path. Returns undefined for anything that is not a scalar at the end: an object or
// an array there means the operator pointed at the wrong level, which is a mistake to report rather
// than a value to coerce.
export function readPath(body: unknown, path: string): string | undefined {
  return readScalar(walkPath(body, path));
}

// The leaves an APPOINTMENT path may point at, which is `collectLeaves` paired with this module's
// own scalar rule — the pairing is the invariant, and `json-path.ts` says why.
export function sampleLeaves(root: unknown, max = 200): SampleLeaf[] {
  return collectLeaves(root, readScalar, max);
}

// What a declared response may hand over, per field (the question is whether the consumer needs the
// exact bytes). The ID is IDENTITY: refused, never clipped or repaired, since a changed id is a
// booking the cancel tool never finds, and an oversized one overflows its unique btree index. The
// SUMMARY is DESCRIPTION: clipped (with clipText) and repaired, since it is re-rendered into every
// later turn's prompt and refusing it would cost the pause. The START is parsed as an instant, so
// anything this long cannot be one. Characters Postgres refuses (a NUL, half a character) follow the
// same split: refused for id and start, repaired for the summary.
const MAX_EXTERNAL_ID_CHARS = 200;
const MAX_START_CHARS = 100;
const MAX_SUMMARY_CHARS = 200;

// readPath, plus the length the field can carry. Undefined for over-long, so the caller reports the
// path exactly as it reports one that resolved to nothing: in both cases the operator's fix is to
// point somewhere else.
function readBounded(
  body: unknown,
  path: string,
  max: number,
): string | undefined {
  const v = readPath(body, path);
  if (v === undefined || v.length > max) return undefined;
  return unstorableCodePoints(v) === null ? v : undefined;
}

export interface ExtractedAppointment {
  action: "book" | "cancel";
  provider: string;
  externalId: string;
  startISO?: string;
  summary?: string;
  reminderOffsetsHours?: number[];
  askConfirmationOnLast?: boolean;
}

// A wall clock with no offset, as many booking APIs answer: `14:00` means two in the afternoon WHERE
// THE OPERATOR IS. Downstream `parseStartMs` reads an offset-less datetime as UTC, so it is resolved
// before it gets there, by the CALLER, which knows the agent's timezone (the same boundary as
// calendar-slots.ts). The resolver returns the SAME wall clock with an explicit offset, or null for
// a DST gap, which cannot be an appointment.
const OFFSETLESS_DATETIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export type WallClockResolver = (wall: string) => string | null;

export type ExtractResult =
  | { ok: true; value: ExtractedAppointment }
  // The paths that did not resolve, NAMED. The tool itself succeeded for the model — the booking is
  // real and already made — so this is reported beside the turn rather than returned to it, and the
  // operator's only way to fix the path is to be told which one missed.
  | { ok: false; missing: string[] };

export function extractAppointment(
  decl: AppointmentDeclaration,
  body: unknown,
  // Required, with no default: the two things a caller could mean here are "resolve in the agent's
  // zone" and "this value is already unambiguous", and a default is how the next caller inherits the
  // wrong one in silence. See WallClockResolver.
  resolveWallClock: WallClockResolver,
): ExtractResult {
  const missing: string[] = [];
  const externalId = readBounded(body, decl.idPath, MAX_EXTERNAL_ID_CHARS);
  if (externalId === undefined) missing.push(decl.idPath);
  let startISO: string | undefined;
  if (decl.action === "book" && decl.startPath) {
    startISO = readBounded(body, decl.startPath, MAX_START_CHARS);
    if (startISO === undefined) missing.push(decl.startPath);
    else if (OFFSETLESS_DATETIME.test(startISO)) {
      const resolved = resolveWallClock(startISO);
      if (resolved === null) missing.push(decl.startPath);
      else startISO = resolved;
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  if (externalId === undefined) return { ok: false, missing: [decl.idPath] };
  return {
    ok: true,
    value: {
      action: decl.action,
      provider: decl.provider,
      externalId,
      ...(startISO !== undefined ? { startISO } : {}),
      // A summary that does not resolve is NOT a failure: it only improves the prompt block, and
      // refusing the whole registration over it would trade the pause for a nicer sentence.
      ...(decl.summaryPath
        ? (() => {
            const s = readPath(body, decl.summaryPath);
            return s !== undefined
              ? // makeStorable BEFORE clipText, and the order is not cosmetic: the repair can only
                // shorten (a NUL is dropped, an orphan half becomes one U+FFFD), so repairing first
                // and cutting second leaves nothing behind, while cutting first would hand clipText a
                // value it has to keep the defects of.
                { summary: clipText(makeStorable(s), MAX_SUMMARY_CHARS) }
              : {};
          })()
        : {}),
      ...(decl.reminderOffsetsHours
        ? {
            reminderOffsetsHours: decl.reminderOffsetsHours,
            askConfirmationOnLast: decl.askConfirmationOnLast === true,
          }
        : {}),
    },
  };
}
