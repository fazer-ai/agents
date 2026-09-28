// THE SAMPLE RESPONSE, KEPT FOR AS LONG AS THE TAB IS OPEN AND NOWHERE ELSE: remembered in this
// tab, keyed by the tenant selector and the tool id, so reopening a tool to adjust its template keeps
// the pickers and the preview; a reload, a second tab and a logout do not. Nothing is persisted: a
// redacted shape in a column fails because no lexical rule tells a field name from customer data (a
// map keyed by e-mail), and `localStorage` fails the standing rule in docs/ui.md (a response is
// content data, and a copy outlives every deletion made outside this browser). Design and costs:
// docs/ui.md, "Pointing at a field in a tool's response".

import { VAULT_CHANGED_EVENT, vaultRevision } from "@/client/lib/vaultCache";

export interface ToolSample {
  // The revision of the definition this response came back from, as the row's `updatedAt`. A sample
  // describes ONE version of a tool: change the URL or the response contract, from another tab or
  // over REST or MCP, and its paths stop describing anything while the picker keeps offering them.
  // The id is not enough, because the id is what survives the change.
  revision: string;
  text: string;
  // The status it came back under, or null when it was pasted by hand. Kept with the text because
  // the preview branches on it: a body captured from a 404 the tool declares a "no result" status
  // is projected differently, and restoring the text without it would read that 404 as a 200.
  status: number | null;
  // The credential the request carried, by name, or null for a tool that uses none, for the one
  // question the revision cannot answer: a credential is a ROW OF ITS OWN, so editing its base URL or
  // secret in place changes the host and the authorization while the reference and the tool's
  // `updatedAt` stay the same. A relative `urlTemplate` resolves against that base URL
  // (`credential-wiring.ts`), so the sample can end up describing another server entirely.
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

// A save is in flight for as long as the operator's API takes, and the tool can be deleted or the
// session end inside that window; the late response must not write the sample back. The ticket a
// request carries is THE WORLD AS IT WAS WHEN IT WENT OUT: the clock, and the tenant it was sent
// under, which `keyFor` takes so the write lands in the scope asked about (the selector lives in
// shared `localStorage` and can move mid-flight). The tenant in the key is depth, not isolation:
// tool ids are one autoincrement, so two tenants never share one. The clock is checked per SCOPE:
// a global check would drop tool A's sample when tool B is deleted during A's save.
let clock = 0;
let clearedAt = 0;
const forgottenAt = new Map<string, number>();
// When each key was last written, so a response that was already on the wire cannot land on top of
// a newer one. Dismiss a slow save, reopen the same tool and save again: the first response arrives
// last and would put the older opening's sample back, and the revision cannot tell them apart when
// the second opening loaded the revision the first save committed.
const writtenAt = new Map<string, number>();
// When the vault last changed, anywhere in this tab. A sample that carried a credential describes a
// request the vault decided part of, and the client cannot tell whether the edit touched the one it
// used: the secret never reaches the browser, so there is nothing here to compare. What it CAN tell
// is that a sample with no credential is untouched by any vault edit, which keeps this from being a
// global clear.
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
  // NOTE: ISSUING IS WHAT ORDERS THEM, so the clock moves here and not only when something lands: two
  // saves of the same tool started before either finished would otherwise share a number, and equal
  // numbers cannot be ordered, so a save could lose to one the operator made earlier.
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
  // NOTE: A READ THAT DROPS, because a mismatch is the moment this entry becomes known-useless and
  // there is no other moment anyone would look at it. Left in place it holds a customer's response that
  // can never be served again, and stale entries would evict the one good sample the operator is using.
  if (kept.revision !== revision) {
    samples.delete(key);
    return null;
  }
  return kept;
}

// Called when the tool is SAVED rather than on every keystroke: what comes back is the sample the
// tool was last saved with, not a draft the operator abandoned. WHAT COUNTS AS NOTHING IS DECIDED
// HERE and nowhere else: the caller hands over what is on screen, because a caller that pre-judges
// it is a second copy of this rule, and the copy is what a change to the rule forgets.
export function rememberToolSample(
  toolId: string,
  sample: ToolSample | null,
  // REQUIRED, and that is the point: the ticket the caller read BEFORE its request went out, so a
  // forgetting that happened in the meantime wins. An optional parameter is one a caller forgets with
  // nothing saying so; required, `tsc` notices.
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
  // NOTE: AN EMPTY BODY WITH A STATUS IS STILL A SAMPLE, the one the preview most needs: a test that
  // came back 404 with nothing in it makes the runtime bypass the template, and dropping the status
  // with the empty text would preview that template as APPLIED on the next open. So what is nothing
  // here is neither text nor status.
  if (sample === null) return;
  // NOTE: the vault moved while this save was out, and this sample carried a credential: it was
  // captured against a resolution that may no longer exist (`noteVaultChanged` drops the stored ones;
  // this is the one still on the wire). Truthiness, not a null check, and stored the same way below:
  // the form spells "no credential" as "" and the payload as null, and a rule knowing only one would
  // invalidate samples no vault edit could touch.
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

// WHOSE SAMPLES THESE ARE, told at every transition the console makes. The session ending (logout,
// a 401, the socket's auth-loss close, a `/me` with a null user) must empty the map, or the next
// sign-in on this tab is offered the previous operator's responses. So must A CHANGE FROM ONE
// OPERATOR TO ANOTHER with no null in between (a shared cookie after another tab signs in as B), so
// the question is whether the identity is the SAME. It cannot NOTICE a tab that merely sits there:
// nothing revalidates `/me` after boot, which is the auth model's gap, recorded in docs/roadmap.md.
export function noteOperator(id: string | null): void {
  if (id === operator) return;
  operator = id;
  forgetToolSamples();
}

// THE VAULT AS THIS TAB LAST SAW IT. Exported because a sample also lives on screen, in a form, with
// the definition it was captured against beside it, and a save compares that: dropping the stored
// entry leaves that copy, so the save would put it straight back. The vault's OWN revision, not a
// count of notifications, because `refreshVault` announces twice for one change (on the drop and
// when the new list lands).
export function vaultGeneration(): number {
  return vaultRevision();
}

// What this tab had already reacted to, so the second announcement of one change is not a second
// change.
let vaultSeen = vaultRevision();

// A CREDENTIAL CHANGED, so every sample that used one stops describing a request we can vouch for.
// Scoped to entries carrying a reference, since a tool with no credential cannot be affected, and no
// further: the event says THAT the vault changed, never which entry, and the secret is server-side,
// so this asks for one more test request rather than keep a sample that may describe another host.
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

// Registered here rather than in a component: a credential is edited from three places (the Vault
// panel, the agent editor, the picker inlined in this modal) and the tool editor is mounted for at
// most one. It does NOT hear a credential edited in another tab or over REST or MCP
// (`VAULT_CHANGED_EVENT` is a `window` event), a gap of `vaultCache` recorded in docs/roadmap.md.
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
