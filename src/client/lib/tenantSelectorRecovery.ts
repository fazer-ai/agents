import { dropRejectedSelection } from "@/client/lib/activeTenant";
import { reloadOntoSafeRoute } from "@/client/lib/tenantSwitch";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";

// What a window does when the server refuses the tenant selector it just sent.
//
// One function, because there are exactly TWO senders of that selector and they are not the same
// transport: the Eden client, which attaches it to every API call, and `mediaFetch`, which mirrors it
// on the raw fetches that load media bytes, PDF downloads and template previews (a native
// `<img>`/`<a>` request cannot carry a header, which is why that path exists at all). A recovery
// wired into one of them leaves the other holding a dead id until an unrelated request happens to
// reach the boundary.
//
// The once-flag is per WINDOW, and deliberately not "is anything still stored": localStorage is
// shared across tabs of the same origin, so the first tab to be refused clears it, and a second tab
// still rendered on that tenant would read null, conclude someone else had dealt with it, and stay on
// screen sending no selector at all. Every window that is told its selector is dead reloads itself,
// exactly once. It lives on `window` because that is what it describes — window state, which a test
// simulating a fresh page load can start clean, and a module-scope variable cannot.
const RELOADING = "__tenantSelectorReloading";

export function recoverFromRejectedSelector(response: Response): boolean {
  const rejected = response.headers.get(REJECTED_TENANT_SELECTOR_HEADER);
  if (!rejected || !dropRejectedSelection(rejected)) return false;
  const w = window as unknown as Record<string, boolean | undefined>;
  if (w[RELOADING]) return true;
  w[RELOADING] = true;
  // NOTE: the page on screen was built on the id that just died, and clearing storage neither
  // remounts nor retries the requests it already sent: a one-shot loader would sit in its error state
  // until someone retried it by hand. A tenant SWITCH reloads for the same reason, and this is the
  // same event arriving from the other side — including the detail route it has to land off of.
  reloadOntoSafeRoute();
  return true;
}
