// What an operator-authored HTTP tool declares about the appointment its response describes, and how
// that declaration is read off a response body. Pure: no I/O, no clock.
//
// WHY A DECLARATION AND NOT A TOOL THE AGENT CALLS. The platform learns about a booking from the
// code that made it — the Google Calendar toolpack calls `appointmentBooked` itself, right after the
// POST lands, and the model never decides anything about it. An operator's HTTP tool cannot have
// that line written into it, because the operator writes the tool. So the DEFINITION carries the
// same statement instead. A native tool called afterwards was the obvious alternative and is worse
// in the way that matters: a second call is a call the model can omit, and the failure is silent —
// no follow-up pause, no reminder, nothing in the agent's prompt, and nothing anywhere saying why
// (issue #352). Registration has to be a consequence of the call the model was already going to make.
//
// REMINDERS ARE OPT-IN, and the record is not. Losing the pause is the reported defect and it is
// restored unconditionally; attendance reminders are a message this platform would send on top of
// whatever the operator's own system already sends, so they are armed only where the declaration
// asks for them. Nothing is lost by the default: since #376 an appointment that arms no reminder is
// an ordinary, fully-functioning record.

import {
  DECLARED_PROVIDER,
  readProviderSlug,
} from "@/modules/appointments/provider";
import { normalizeOffsets } from "@/modules/appointments/settings";

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

// A path into a JSON response: dot-separated keys, with a numeric segment indexing an array
// (`data.items.0.id`). Deliberately not JSONPath — the whole surface an operator has to learn is one
// sentence, and a filter expression would be a second language inside a text field.
const PATH_SEGMENT = /^[A-Za-z0-9_$-]+$/;

export function isUsablePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 200 &&
    p.split(".").every((seg) => PATH_SEGMENT.test(seg))
  );
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

// Walk a dotted path. Returns undefined for anything that is not a scalar at the end: an object or
// an array there means the operator pointed at the wrong level, which is a mistake to report rather
// than a value to coerce.
export function readPath(body: unknown, path: string): string | undefined {
  let cur: unknown = body;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur)
      ? /^\d+$/.test(seg)
        ? cur[Number(seg)]
        : undefined
      : (cur as Record<string, unknown>)[seg];
  }
  return readScalar(cur);
}

// What a path is allowed to END on, factored out of readPath because the sample picker below has to
// offer exactly the leaves readPath would accept. Two readers of the same question drift; one does
// not, and a picker that offers a leaf the reader then refuses is worse than no picker.
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

export interface SampleLeaf {
  path: string;
  value: string;
}

// Every place in a sample response that a declaration could point AT, in document order, so the
// operator picks a path instead of typing one. Typing is where the expensive mistake lives: the
// gates in the form catch a MALFORMED path, and nothing catches a well-formed path aimed at the
// wrong key — `data.id` where the field is `data.appointment.id` passes every check and simply
// finds nothing, at which point the platform records no appointment and the operator has no idea
// why.
//
// Both filters mirror a reader rather than a taste, which is the property that makes the offer
// trustworthy:
//
//   - the VALUE has to be one readScalar returns, so an object, an array, null, a boolean, an empty
//     string and an already-rounded integer are all absent, exactly as they would be at read time;
//   - every KEY between here and the root has to fit the segment grammar on its own, checked before
//     the segments are joined. Joining destroys the evidence: a key named literally `a.b` yields the
//     path `a.b`, which isUsablePath accepts (it splits on the dot and both halves are fine) while
//     readPath walks it as body.a.b — a different place entirely. Checking the assembled path is
//     therefore not the same check, and it is the one that would have shipped the exact silent
//     mis-aim this picker exists to remove.
//
// Bounded on both axes: a sample is pasted by hand, and a response with thousands of rows would
// otherwise render thousands of buttons.
export function sampleLeaves(root: unknown, max = 200): SampleLeaf[] {
  const out: SampleLeaf[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= max || depth > 10) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        walk(v, path === "" ? String(i) : `${path}.${i}`, depth + 1);
      });
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        // The whole subtree goes with the key: nothing under an unaddressable key is addressable.
        if (!PATH_SEGMENT.test(k)) continue;
        walk(v, path === "" ? k : `${path}.${k}`, depth + 1);
      }
      return;
    }
    const value = readScalar(node);
    // isUsablePath still answers for the LENGTH cap, which is a property of the whole path.
    if (value !== undefined && isUsablePath(path)) out.push({ path, value });
  };
  walk(root, "", 0);
  return out;
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

export type ExtractResult =
  | { ok: true; value: ExtractedAppointment }
  // The paths that did not resolve, NAMED. The tool itself succeeded for the model — the booking is
  // real and already made — so this is reported beside the turn rather than returned to it, and the
  // operator's only way to fix the path is to be told which one missed.
  | { ok: false; missing: string[] };

export function extractAppointment(
  decl: AppointmentDeclaration,
  body: unknown,
): ExtractResult {
  const missing: string[] = [];
  const externalId = readPath(body, decl.idPath);
  if (externalId === undefined) missing.push(decl.idPath);
  let startISO: string | undefined;
  if (decl.action === "book" && decl.startPath) {
    startISO = readPath(body, decl.startPath);
    if (startISO === undefined) missing.push(decl.startPath);
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
            return s !== undefined ? { summary: s } : {};
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
