/// <reference lib="dom" />

// The period control, rendered.
//
// EVERY PAGE-LEVEL RULE HERE SURVIVED A PURE TEST, which is why this file exists next to
// `audit-period.test.ts` rather than inside it. `auditPeriod` answers "which row do these bounds
// mean"; the three rules below are about the WIRING — what the page puts in the URL, which clock a
// handler reads, and when the draft is allowed to disagree with the committed window. All three
// were found by review after the pure suite was green.

import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ToastProvider } from "@/client/components";

// The page reads the principal's role to decide whether to offer the scope selector (#520). These
// files are not about that, so the mock hands it the ordinary operator: a TENANT_ADMIN, which is
// the role every assertion below was written against.
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { AuditPage } = await import("@/client/pages/AuditPage");

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ entries: [], nextCursor: null, latestAt: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  setSystemTime();
});

// The search string as the page last wrote it, so a test can assert what a shared link would carry.
let search = "";
function Probe() {
  search = useLocation().search;
  return null;
}

// The controls are found positionally on purpose: no i18n backend is configured under test, so every
// label is whatever `t` falls back to, and pinning those strings here would make this file fail on a
// copy edit. The page renders exactly two `<select>`s — the door, then the period.
function mount(url: string) {
  const view = render(
    <ToastProvider>
      <MemoryRouter initialEntries={[url]}>
        <AuditPage />
        <Probe />
      </MemoryRouter>
    </ToastProvider>,
  );
  const selects = view.container.querySelectorAll("select");
  expect(selects).toHaveLength(2);
  return {
    ...view,
    period: selects[1] as HTMLSelectElement,
    dates: () =>
      Array.from(
        view.container.querySelectorAll<HTMLInputElement>('input[type="date"]'),
      ),
  };
}

function pick(select: HTMLSelectElement, value: string) {
  fireEvent.change(select, { target: { value } });
}

// 2026-08-31 is a Monday, so `this-week` and `today` are the same two dates and the derivation
// cannot tell them apart. Picking the row that comes later in the list is the case that broke.
test("a preset whose window another preset also names stays picked", async () => {
  setSystemTime(new Date("2026-08-31T12:00:00Z"));
  const view = mount("/audit");
  await waitFor(() => expect(view.period.value).toBe(""));

  pick(view.period, "this-week");

  await waitFor(() => expect(view.period.value).toBe("this-week"));
  // And the link carries it, which is the only way the choice survives a paste.
  expect(new URLSearchParams(search).get("period")).toBe("this-week");
  expect(new URLSearchParams(search).get("from")).toBe("2026-08-31");
});

// The handler runs long after the render that created it. A page left open overnight renders once,
// before midnight, and a preset resolved from that render's `today` is a day behind.
//
// THE TWO INSTANTS ARE BUILT FROM LOCAL COMPONENTS, not from a `Z` literal. `todayKey` reads the
// LOCAL calendar, so a UTC instant only crosses midnight in a zone that agrees with UTC — and west
// of it, `2026-08-31T23:59Z` and `2026-09-01T00:01Z` are the same local day and nothing rolls over.
// `bun test` happens to pin UTC today, which would make this pass while testing nothing.
const BEFORE_MIDNIGHT = new Date(2026, 7, 31, 23, 59);
const AFTER_MIDNIGHT = new Date(2026, 8, 1, 0, 1);

test("a preset picked after midnight resolves against the new day", async () => {
  setSystemTime(BEFORE_MIDNIGHT);
  const view = mount("/audit");
  await waitFor(() => expect(view.period.value).toBe(""));

  setSystemTime(AFTER_MIDNIGHT);
  pick(view.period, "today");

  await waitFor(() => expect(view.period.value).toBe("today"));
  const params = new URLSearchParams(search);
  expect([params.get("from"), params.get("to")]).toEqual([
    "2026-09-01",
    "2026-09-01",
  ]);
});

// Showing two inputs is not a query. Seeding them with today committed that window, so an operator
// who opened the row to type a range watched the unfiltered trail narrow to today first.
test("opening custom on an unfiltered trail commits no window", async () => {
  setSystemTime(BEFORE_MIDNIGHT);
  const view = mount("/audit");
  await waitFor(() => expect(view.period.value).toBe(""));

  pick(view.period, "custom");

  await waitFor(() => expect(view.dates()).toHaveLength(2));
  expect(view.dates().map((d) => d.value)).toEqual(["", ""]);
  const params = new URLSearchParams(search);
  expect([params.get("from"), params.get("to")]).toEqual([null, null]);
  expect(params.get("period")).toBe("custom");
});

// The other half of the same rule: a window already applied is carried into the row untouched.
test("opening custom over an applied window keeps it", async () => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  const view = mount("/audit?from=2026-08-01&to=2026-08-31");
  await waitFor(() => expect(view.period.value).toBe("last-month"));

  pick(view.period, "custom");

  await waitFor(() => expect(view.dates()).toHaveLength(2));
  expect(view.dates().map((d) => d.value)).toEqual([
    "2026-08-01",
    "2026-08-31",
  ]);
});

// A preset can leave the bounds exactly where they are and change only the mode. The draft is
// resynced from the URL, so a resync keyed on the bounds alone never fires and the half-cleared
// draft outlives the mode it belonged to.
test("a half-cleared custom draft does not survive a trip through a preset", async () => {
  setSystemTime(new Date("2026-09-03T12:00:00Z"));
  const view = mount("/audit?from=2026-09-03&to=2026-09-03&period=custom");
  await waitFor(() => expect(view.dates()).toHaveLength(2));

  // Unusable as a pair, so nothing is committed and the URL still filters by the day.
  fireEvent.change(view.dates()[0] as HTMLInputElement, {
    target: { value: "" },
  });
  expect(view.dates()[0]?.value).toBe("");
  expect(new URLSearchParams(search).get("from")).toBe("2026-09-03");

  // `today` is that same window, so only `period` moves.
  pick(view.period, "today");
  await waitFor(() => expect(view.period.value).toBe("today"));

  pick(view.period, "custom");
  await waitFor(() => expect(view.dates()).toHaveLength(2));
  expect(view.dates().map((d) => d.value)).toEqual([
    "2026-09-03",
    "2026-09-03",
  ]);
});

// NOTHING RE-RENDERS THIS PAGE ON ITS OWN. Filtered to Today and left open overnight, it went on
// saying "Today" while its fixed bounds queried yesterday -- the correction was already written
// (`selectedPreset` drops a named mode whose arithmetic stopped yielding these bounds) and had no
// occasion to run. The timer is the occasion, and this is the only test that proves it exists: the
// clock is moved past midnight and NOTHING is clicked.
test("a trail left open across midnight stops calling yesterday Today", async () => {
  setSystemTime(new Date(2026, 7, 31, 23, 59, 59, 900));
  const view = mount("/audit?from=2026-08-31&to=2026-08-31&period=today");
  await waitFor(() => expect(view.period.value).toBe("today"));

  setSystemTime(new Date(2026, 8, 1, 0, 0, 1));

  await waitFor(() => expect(view.period.value).toBe("yesterday"), {
    timeout: 5000,
  });
  // The window itself is untouched: relabelling is honesty about what the bounds mean, not a silent
  // re-filter of a page the operator left pointing at a specific day.
  const params = new URLSearchParams(search);
  expect([params.get("from"), params.get("to")]).toEqual([
    "2026-08-31",
    "2026-08-31",
  ]);
});

// A URL can carry one bound -- bookmarked, hand-edited, or written by this page. `selectedPreset`
// calls that filtered and opens the custom row on it, and the pair rule then refused every edit:
// the input showed the new date while every request still used the old one.
test("a one-sided window can be edited", async () => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  const view = mount("/audit?from=2026-08-01");
  await waitFor(() => expect(view.period.value).toBe("custom"));
  expect(view.dates().map((d) => d.value)).toEqual(["2026-08-01", ""]);

  fireEvent.change(view.dates()[0] as HTMLInputElement, {
    target: { value: "2026-08-20" },
  });

  await waitFor(() =>
    expect(new URLSearchParams(search).get("from")).toBe("2026-08-20"),
  );
  expect(new URLSearchParams(search).get("to")).toBeNull();
});

test("and emptying its last bound removes the filter", async () => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  const view = mount("/audit?from=2026-08-01");
  await waitFor(() => expect(view.period.value).toBe("custom"));

  fireEvent.change(view.dates()[0] as HTMLInputElement, {
    target: { value: "" },
  });

  await waitFor(() =>
    expect(new URLSearchParams(search).get("from")).toBeNull(),
  );
});

// The other side of the same rule, and the reason it is not simply "commit whatever is valid": with
// a pair applied, clearing one input is what happens MID-EDIT, and committing there would fire a
// request off a window nobody asked for and drop a bound from the URL.
test("clearing one input of an applied pair commits nothing", async () => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  // A window no preset names, so the row opens as custom on its own bounds.
  const view = mount("/audit?from=2026-08-05&to=2026-08-20");
  await waitFor(() => expect(view.dates()).toHaveLength(2));

  fireEvent.change(view.dates()[0] as HTMLInputElement, {
    target: { value: "" },
  });

  expect(view.dates()[0]?.value).toBe("");
  const params = new URLSearchParams(search);
  expect([params.get("from"), params.get("to")]).toEqual([
    "2026-08-05",
    "2026-08-20",
  ]);
});

// An empty page has two reasons and only one of them is "nothing happened". These actions write rows
// keyed to no tenant, which this read cannot reach at all, so the ordinary "no entries match these
// filters" would be the page asserting something it never checked. The fleet READ is #520.
test("a fleet-level action says why the page is empty", async () => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  const view = mount("/audit?action=mcp_client.create");

  // The rendered strings, not the keys: no i18n backend is configured under test, so `t` falls back
  // to the default each call site declares.
  await waitFor(() =>
    expect(view.container.textContent).toContain(
      "not recorded on a tenant's trail",
    ),
  );
  expect(view.container.textContent).toContain("mcp_client.create");
  expect(view.container.textContent).not.toContain("No entries match");
});

// The other side: an ordinary action with no rows is an ordinary empty result, and saying otherwise
// would teach the operator to distrust every empty page.
test("a tenant-level action gets the ordinary empty result", async () => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  const view = mount("/audit?action=agent.create");

  await waitFor(() =>
    expect(view.container.textContent).toContain("No entries match"),
  );
  expect(view.container.textContent).not.toContain(
    "not recorded on a tenant's trail",
  );
});
