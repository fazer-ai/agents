import { dropRejectedSelection } from "@/client/lib/activeTenant";
import { reloadOntoSafeRoute } from "@/client/lib/tenantSwitch";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";

// What a window does when the server refuses the tenant selector it just sent. One function for the
// TWO senders of that selector: the Eden client on every API call, and `mediaFetch` on the raw
// fetches a native `<img>`/`<a>` needs; wired into one only, the other would keep a dead id. The
// once-flag is per WINDOW, not "is anything still stored": localStorage is shared across tabs, so a
// second tab would read null and stay on screen sending no selector. Every refused window reloads
// itself exactly once. It lives on `window` because it is window state, which a test simulating a
// fresh page load can start clean and a module-scope variable cannot.
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
