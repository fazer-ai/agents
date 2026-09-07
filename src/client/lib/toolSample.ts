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

// Keyed by the tenant selector as well, so a SUPER_ADMIN switching tenants in the same tab is never
// offered the sample captured under the other one. Read at call time rather than captured, for the
// same reason `activeTenant.ts` reads it at call time: the selection can change under a live tab.
function keyFor(toolId: string): string {
  let tenant: string | null = null;
  try {
    tenant = localStorage.getItem("@app:active-tenant");
  } catch {
    // A browser that refuses storage entirely still gets a working cache, under the home tenant.
  }
  return `${tenant ?? ""}:${toolId}`;
}

export function recallToolSample(toolId: string): ToolSample | null {
  return samples.get(keyFor(toolId)) ?? null;
}

// Called when the tool is SAVED rather than on every keystroke: what comes back is the sample the
// tool was last saved with, not a draft the operator abandoned.
export function rememberToolSample(
  toolId: string,
  sample: ToolSample | null,
): void {
  const key = keyFor(toolId);
  // DELETED FIRST AND UNCONDITIONALLY, which is also what re-dates the entry: `Map` keeps insertion
  // order, so deleting before setting is what makes the eviction below drop the least recently
  // saved rather than the first one ever saved.
  samples.delete(key);
  if (sample === null || sample.text.trim() === "") return;
  if (sample.text.length > MAX_CHARS) return;
  samples.set(key, { text: sample.text, status: sample.status });
  while (samples.size > MAX_ENTRIES) {
    const oldest = samples.keys().next();
    if (oldest.done) break;
    samples.delete(oldest.value);
  }
}

// Logout, and any other point where the console stops answering for this operator. Nothing here
// survives a reload, so this is about the tab that stays open after someone signs out on it.
export function forgetToolSamples(): void {
  samples.clear();
}
