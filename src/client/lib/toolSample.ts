// THE SAMPLE RESPONSE, KEPT FOR AS LONG AS THE TAB IS OPEN AND NOWHERE ELSE (issue #566).
//
// The Sample response field in the HTTP tool editor used to be cleared on every open, so an operator
// coming back to adjust a response template, the most common reason to reopen an HTTP tool, found
// pickers that offered nothing, no preview at all, and no "Insert a field" button. The two ways out
// were pasting a response again by hand or spending a real call against the customer's API to
// recover what had been on screen once.
//
// So it is remembered, in this tab, keyed by the tenant selector and the tool id. Closing the modal
// keeps it, and so does navigating to another page and back; a reload, a second tab and a logout do
// not.
//
// WHY NOTHING IS PERSISTED, ANYWHERE, WHICH IS THE WHOLE DESIGN. Two earlier drafts were taken apart
// in review, one for each place a value can be kept, and the two refusals are what this file is:
//
// 1. A REDACTED SHAPE OF THE RESPONSE IN A COLUMN, so the pickers would work on any machine. No
//    lexical rule establishes that a key is a field name rather than customer data:
//    `{"users": {"ana@example.com": …}}` is a map keyed by an e-mail, and `{"users": {"Ana": …}}` is
//    one keyed by a first name that any identifier pattern accepts. Since the keys cannot be
//    separated from the data, and a path THROUGH a map is worthless to an operator anyway (it
//    resolves for exactly one customer), there was nothing left worth storing.
// 2. THE RESPONSE IN `localStorage`. `docs/ui.md` carries a standing product rule that names this
//    case outright: localStorage is not admissible for product data, and "History, save, remember,
//    resume" all belong to a backend with `tenant_id` and RLS. A captured response is content data
//    and not a UI preference, and the copy would outlive every deletion that does not go through
//    this browser: a tool dropped over REST or MCP, or from another machine, leaves it behind.
//
// Both refusals point the same way, and the one place left to keep a value is the one the response
// already occupies while the modal is open. So it is never written down at all, which is what lets
// "we never store the customer's response" stand with no qualification: no column, no per-tool
// opt-in, no backup question, no export rule, no retention policy, and nothing a future reader has
// to re-derive before trusting it.
//
// WHAT THAT COSTS, stated rather than papered over: a reload, a second tab or a second machine gets
// what it gets today, which is no offer and "Send a test request" as the way back.

export interface ToolSample {
  // The revision of the definition this response came back from, as the row's `updatedAt`. A sample
  // describes ONE version of a tool: change the URL or the response contract, from another tab or
  // over REST or MCP, and the paths it offers stop describing anything, while the picker keeps
  // offering them and the preview keeps rendering over them (round 9 of review). The id matching is
  // not enough, because the id is what survives the change.
  revision: string;
  text: string;
  // The status it came back under, or null when it was pasted by hand. Kept with the text because
  // the preview branches on it: a body captured from a 404 the tool declares a "no result" status
  // is projected differently, and restoring the text without it would read that 404 as a 200.
  status: number | null;
}

// Bounded on both axes, because this holds response bodies for the life of the tab. An operator
// works on one tool at a time, so a handful of entries covers going back and forth between a tool
// and the one it was copied from, and past that the oldest goes. The per-entry cap is well beyond
// anything a person pastes to design a template against, and a response bigger than it is one they
// will re-fetch anyway.
const MAX_ENTRIES = 8;
const MAX_CHARS = 512_000;

const samples = new Map<string, ToolSample>();

// A save is in flight for as long as the operator's API takes, and both things that end a sample's
// life can happen inside that window: the tool is deleted, or the session ends. Without this the
// response arrives afterwards and writes the sample back in, so a deletion or a logout would be
// undone by a request that was already on the wire (round 4 of review).
//
// The ticket a request carries is THE WORLD AS IT WAS WHEN IT WENT OUT, and that is one value rather
// than two because three review rounds found the same shape: something the continuation reads at the
// end that had already changed. It carries the clock and the tenant the request was sent under, and
// `keyFor` takes the second so the write lands in the scope that was asked about. The selector lives
// in `localStorage`, which is shared across tabs and can move while a request is in flight
// (`activeTenant.ts` says so in as many words), so reading it in the continuation keys the answer to
// a question nobody asked (round 7 of review).
//
// What the tenant in the key is NOT is the thing that stops one tenant's response reaching another:
// `ToolDefinition.id` is a plain autoincrement on one table, so two tenants never share a tool id
// and a mis-keyed entry is unreachable rather than aliased. It is depth, and a future reader should
// not over-trust it.
//
// The clock is checked per SCOPE rather than globally, because a global check over-rejects: deleting
// tool B while tool A's save is out would drop A's sample too, and the operator sees a tool they
// never touched come back with an older response or none (round 6 of review).
let clock = 0;
let clearedAt = 0;
const forgottenAt = new Map<string, number>();

// The identity the entries belong to. `undefined` is "nobody has said yet", which is not the same
// as a signed-out `null`: the first thing the console says on boot is a real answer either way, and
// starting at `null` would make a boot into a signed-out state a no-op rather than a transition.
let operator: string | null | undefined;

export interface SampleTicket {
  at: number;
  tenant: string | null;
}

export function sampleTicket(): SampleTicket {
  return { at: clock, tenant: activeTenant() };
}

function activeTenant(): string | null {
  try {
    return localStorage.getItem("@app:active-tenant");
  } catch {
    // A browser that refuses storage entirely still gets a working cache, under the home tenant.
    return null;
  }
}

// Read at call time by the reader (a render asks about the tenant on screen now) and taken from the
// ticket by the writers (a continuation asks about the tenant its request went out under).
function keyFor(toolId: string, tenant: string | null): string {
  return `${tenant ?? ""}:${toolId}`;
}

// Answers with the entry only when it describes the revision being asked about. The caller passes
// the `updatedAt` of the row it just loaded, so a definition someone else changed in the meantime
// gets what a tool this tab has never opened gets: nothing, and "Send a test request".
export function recallToolSample(
  toolId: string,
  revision: string,
): ToolSample | null {
  const kept = samples.get(keyFor(toolId, activeTenant()));
  if (kept === undefined) return null;
  if (kept.revision !== revision) return null;
  return kept;
}

// Called when the tool is SAVED rather than on every keystroke: what comes back is the sample the
// tool was last saved with, not a draft the operator abandoned.
//
// WHAT COUNTS AS NOTHING IS DECIDED HERE and nowhere else. The caller hands over what is on screen,
// because a caller that pre-judges it is a second copy of this rule, and the copy is what a change
// to the rule forgets (measured: with the judgement duplicated at the one call site, reverting it
// there survived the whole battery).
export function rememberToolSample(
  toolId: string,
  sample: ToolSample | null,
  // REQUIRED, and that is the point: the ticket the caller read BEFORE its request went out, so a
  // forgetting that happened in the meantime wins. Optional, it is a parameter a caller forgets and
  // nothing says so; required, `tsc` is the one that notices, which is what a source fence over the
  // same question could only approximate (measured: with it optional, dropping the argument at the
  // one call site survived the whole battery).
  since: SampleTicket,
): void {
  const key = keyFor(toolId, since.tenant);
  // The session ended after the ticket was taken, or THIS tool was forgotten after it. A forgetting
  // of some other tool is not this save's business.
  if (clearedAt > since.at) return;
  const forgotten = forgottenAt.get(key);
  if (forgotten !== undefined && forgotten > since.at) return;
  // DELETED FIRST AND UNCONDITIONALLY, which is also what re-dates the entry: `Map` keeps insertion
  // order, so deleting before setting is what makes the eviction below drop the least recently
  // saved rather than the first one ever saved.
  samples.delete(key);
  // AN EMPTY BODY WITH A STATUS IS STILL A SAMPLE, and it is the one the preview most needs: a test
  // that came back 404 with nothing in it makes the runtime bypass the template, and a template that
  // reads no field previews fine over an empty body. Dropped for having no text, the status went
  // with it, and the reopened tool previewed that same template as APPLIED, under a box that says
  // "exactly what the agent would receive" (round 8 of review). So what is nothing here is neither
  // text nor status.
  if (sample === null) return;
  if (sample.text.trim() === "" && sample.status === null) return;
  if (sample.text.length > MAX_CHARS) return;
  samples.set(key, {
    revision: sample.revision,
    text: sample.text,
    status: sample.status,
  });
  while (samples.size > MAX_ENTRIES) {
    const oldest = samples.keys().next();
    if (oldest.done) break;
    samples.delete(oldest.value);
  }
}

// THE TOOL IS GONE. A response left behind describes a row that no longer exists, and it is the
// customer's data sitting in a tab that has no use for it. Separate from `rememberToolSample(id,
// null)`, which is a save saying there is no sample: this is a lifecycle event, so it invalidates
// the saves that are in flight.
export function forgetToolSample(toolId: string, since: SampleTicket): void {
  const key = keyFor(toolId, since.tenant);
  clock++;
  forgottenAt.set(key, clock);
  samples.delete(key);
}

// WHOSE SAMPLES THESE ARE, told to this module at every transition the console makes, and the rule
// lives here rather than at the caller so it can be exercised without one.
//
// The obvious half is the session ending: an explicit logout, a 401 on any request, an auth-loss
// close on the socket, a `/me` that answers with a null user. All of them leave the tab on the login
// screen with this map still full, and the next sign-in on that tab would be offered the previous
// operator's responses.
//
// The half that is not obvious is A CHANGE FROM ONE OPERATOR TO ANOTHER with no null in between,
// which is what a shared cookie does: a tab sitting on A while another tab signs out and back in as
// B sees `/me` answer B directly. Asking only whether the user went away misses it, and the entries
// are keyed by tenant and tool, so B would be handed A's captured response on the same tool (round
// 6 of review). So the question is whether the identity is the SAME, not whether there is one.
export function noteOperator(id: string | null): void {
  if (id === operator) return;
  operator = id;
  forgetToolSamples();
}

// Nothing here survives a reload, so all of this is about the tab that stays open.
function forgetToolSamples(): void {
  clock++;
  clearedAt = clock;
  samples.clear();
  // Nothing older than a global clear can be accepted anyway, so the per-tool marks are dead weight
  // from here: this is what keeps that map from growing one entry per tool ever deleted in this tab.
  forgottenAt.clear();
}
