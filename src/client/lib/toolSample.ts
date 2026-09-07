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

import { VAULT_CHANGED_EVENT, vaultRevision } from "@/client/lib/vaultCache";

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
  // The credential the request carried, by name, or null for a tool that uses none. It is here for
  // one question only, and it is the question the revision cannot answer: a credential is a ROW OF
  // ITS OWN, so editing its base URL or its secret in place changes the host the tool reaches and
  // the authorization it sends while the reference stays the same word and the tool's `updatedAt`
  // never moves (round 13 of review). A relative `urlTemplate` is resolved against that base URL by
  // `credential-wiring.ts`, so the sample can end up describing another server entirely.
  credentialRef: string | null;
}

// WHAT COUNTS AS NO SAMPLE AT ALL, exported because the editor asks the same question when it
// records which definition the sample on screen describes, and a second spelling of it is what a
// change to this rule forgets. An empty body with a status IS a sample, and it is the one the
// preview most needs (see `rememberToolSample`).
export function sampleIsNothing(text: string, status: number | null): boolean {
  return text.trim() === "" && status === null;
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
// When each key was last written, so a response that was already on the wire cannot land on top of
// a newer one. Dismiss a slow save, reopen the same tool and save again: the first response arrives
// last and would put the older opening's sample back, and the revision cannot tell them apart when
// the second opening loaded the revision the first save committed (round 12 of review).
const writtenAt = new Map<string, number>();
// When the vault last changed, anywhere in this tab. A sample that carried a credential describes a
// request the vault decided part of, and the client cannot tell whether the edit touched the one it
// used: the secret never reaches the browser, so there is nothing here to compare. What it CAN tell
// is that a sample with no credential is untouched by any vault edit, which is what keeps this from
// being the global clear round 6 refused.
let vaultChangedAt = 0;

// The identity the entries belong to. `undefined` is "nobody has said yet", which is not the same
// as a signed-out `null`: the first thing the console says on boot is a real answer either way, and
// starting at `null` would make a boot into a signed-out state a no-op rather than a transition.
let operator: string | null | undefined;

export interface SampleTicket {
  at: number;
  tenant: string | null;
}

export function sampleTicket(): SampleTicket {
  // ISSUING IS WHAT ORDERS THEM, so the clock moves here and not only when something lands. Reading
  // it without moving it gave two saves of the same tool that started before either finished the
  // SAME number, and equal numbers cannot be ordered: whichever response arrived first marked the
  // key and the other was refused as stale, so a save could lose to one the operator made earlier
  // (round 14 of review). The one this guards against, an OLDER opening's answer landing on a newer
  // one, is the same comparison with the numbers finally distinct.
  clock++;
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
  const key = keyFor(toolId, activeTenant());
  const kept = samples.get(key);
  if (kept === undefined) return null;
  // A READ THAT DROPS, because a mismatch is the moment this entry becomes known-useless and there
  // is no other moment where anyone would look at it. Left in place it holds a customer's response
  // that can never be served again, and it occupies one of the slots below: seven stale entries
  // would evict the one good sample the operator is actually working with (round 10 of review).
  if (kept.revision !== revision) {
    samples.delete(key);
    return null;
  }
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
  // A newer save already answered for this tool, so this one is an older opening's answer.
  const written = writtenAt.get(key);
  if (written !== undefined && written > since.at) return;
  // THE TICKET'S OWN NUMBER, not a fresh one: what is being recorded is which REQUEST answered for
  // this key, and the request is ordered by when it went out. Stamping the moment it landed says
  // the opposite, that whatever finished first is the newest.
  writtenAt.set(key, since.at);
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
  // The vault moved while this save was out, and this sample carried a credential: it was captured
  // against a resolution that may no longer exist. The stored entries are dropped by
  // `noteVaultChanged` at the moment of the change; this is the same rule for the one that was still
  // on the wire and has no entry to drop.
  // Truthiness rather than a null check, and stored the same way below: the form spells "no
  // credential" as an empty string and the payload spells it as null, so a rule that only knew one
  // of them would turn a caller reading the other into round 6's global invalidation.
  if (sample.credentialRef && vaultChangedAt > since.at) return;
  if (sampleIsNothing(sample.text, sample.status)) return;
  if (sample.text.length > MAX_CHARS) return;
  samples.set(key, {
    revision: sample.revision,
    text: sample.text,
    status: sample.status,
    credentialRef: sample.credentialRef || null,
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
  // WHEN IT LANDED, and NOT the ticket's own number, which is where this parts company with the
  // write beside it and the difference is the point. A write is one of several answers competing
  // for a key, so it is ordered by when its request went out. A deletion ENDS the key: the row is
  // gone, nothing will ever ask for it again, and a save that started after the delete went out
  // would leave the customer's response in a map that has no use for it. So it wins over everything
  // still in flight, whenever that flight began.
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

// A CREDENTIAL CHANGED, so every sample that used one stops describing a request we can vouch for.
// Scoped to the entries that carry a reference rather than emptying the map, because a tool with no
// credential cannot be affected by a vault edit and round 6 already paid for a global invalidation:
// the operator sees a tool they never touched come back with an older response or none.
//
// It is not scoped any further than that, and the reason is not laziness: the event announces THAT
// the vault changed and never which entry, the panel can rename and delete as well as edit, and the
// secret itself is server-side. Between keeping a sample that may describe another host and asking
// for one more test request, this asks for the test request.
// THE VAULT AS THIS TAB LAST SAW IT. Exported because the entries in this map are not the only
// place a sample lives: one is also on screen, in a form, with the definition it was captured
// against recorded beside it, and that recording is what a save compares. Dropping the stored entry
// leaves that copy untouched, so the save would put it straight back (round 14 of review).
//
// It is the vault's OWN revision and not a count of notifications, because `refreshVault` announces
// twice for one change — on the drop and again when the new list lands — so a sample captured
// between the two halves of a single refresh would be marked stale by the second half of the change
// it already describes (round 15 of review).
export function vaultGeneration(): number {
  return vaultRevision();
}

// What this tab had already reacted to, so the second announcement of one change is not a second
// change.
let vaultSeen = vaultRevision();

export function noteVaultChanged(): void {
  const now = vaultRevision();
  if (now === vaultSeen) return;
  vaultSeen = now;
  clock++;
  vaultChangedAt = clock;
  for (const [key, kept] of samples)
    if (kept.credentialRef) {
      forgottenAt.set(key, clock);
      samples.delete(key);
    }
}

// Registered here rather than in a component, because a credential is edited from three places (the
// Vault panel, the agent editor, and the picker inlined in this very modal) and the tool editor is
// mounted for at most one of them. A listener that lives in a component is a listener that is absent
// exactly when the edit happens somewhere else.
//
// WHAT IT DOES NOT HEAR, so a future reader does not over-trust it: `VAULT_CHANGED_EVENT` is a
// `window` event dispatched by the window that made the change. A credential edited in a second tab,
// over REST or over MCP never reaches this one, and editing a credential does not move the tool's
// `updatedAt` either, so such a change is invisible to everything here. That is a property of
// `vaultCache` and it costs more than a sample — the same window shows the stale base URL under the
// URL field and sends test requests against it — so it is recorded in `docs/roadmap.md` with the
// shape of the fix rather than half-closed here (round 16 of review).
if (typeof window !== "undefined")
  window.addEventListener(VAULT_CHANGED_EVENT, noteVaultChanged);

// Nothing here survives a reload, so all of this is about the tab that stays open.
function forgetToolSamples(): void {
  clock++;
  clearedAt = clock;
  samples.clear();
  // Nothing older than a global clear can be accepted anyway, so the per-tool marks are dead weight
  // from here: this is what keeps those maps from growing one entry per tool touched in this tab.
  forgottenAt.clear();
  writtenAt.clear();
}
