/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ToastProvider } from "@/client/components/Toast";
import { SpendCeilingCard } from "@/client/pages/resources/SpendCeilingCard";

// The spend ceiling's card shows DOLLARS as the usage ledger priced them, and beside the bar the
// health of the figure and the calls no price covered: a ceiling that undercounts, a snapshot nobody
// refreshed, a block written in tokens, each has a sentence on this screen, because this is the
// screen that shows the bar.

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

type Entry = {
  source: string;
  usedUsd: number;
  ceilingUsd: number | null;
  state: string;
  polledAt: string | null;
  pollError: string | null;
  pollFailedAt: string | null;
  stale: boolean;
  unpricedCalls: number;
  unpricedModels: string[];
};

const entry = (patch: Partial<Entry> & { source: string }): Entry => ({
  usedUsd: 0,
  ceilingUsd: null,
  state: "allowed",
  polledAt: "2026-08-15T11:58:00.000Z",
  pollError: null,
  pollFailedAt: null,
  stale: false,
  unpricedCalls: 0,
  unpricedModels: [],
  ...patch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function installFetchStub(usage: Record<string, unknown>) {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, body });
    if (
      method === "GET" &&
      url.pathname === "/api/v1/tenant-settings/spend-ceiling/usage"
    ) {
      return json({ instance: {}, ...usage });
    }
    if (
      method === "PUT" &&
      url.pathname === "/api/v1/tenant-settings/spend-ceiling"
    ) {
      return json({ instance: {}, spendCeiling: { ...settings, ...body } });
    }
    return json({}, 404);
  }) as typeof fetch;
}

const settings = {
  enabled: true,
  monthlyInboxUsd: 20,
  monthlyPlaygroundUsd: 0,
  overCeilingMessage: "x",
  handoffEnabled: true,
  noticeCooldownSeconds: 300,
  warnAtPercent: 80,
  legacyTokens: null as { inbox: number; playground: number } | null,
};

const baseUsage = () => ({
  enabled: true,
  periodStart: "2026-08-01T00:00:00.000Z",
  legacyTokens: null,
  pollIntervalMs: 300_000,
  entries: [
    entry({
      source: "inbox",
      usedUsd: 22.5,
      ceilingUsd: 20,
      state: "over",
    }),
    entry({ source: "playground", usedUsd: 9.9 }),
  ],
});

function renderCard(value = settings) {
  return render(
    <ToastProvider>
      <SpendCeilingCard value={value} onSaved={() => {}} />
    </ToastProvider>,
  );
}

const has = (text: string | RegExp) =>
  screen.queryByText(text, { exact: false }) !== null;

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("the spend ceiling card", () => {
  test("shows the month in dollars against the ceiling, and when it was refreshed", async () => {
    installFetchStub(baseUsage());
    renderCard();
    await waitFor(() => {
      expect(has("$22.50 of $20.00")).toBe(true);
    });
    expect(has("$9.90 (no ceiling)")).toBe(true);
    expect(screen.queryAllByText(/Refreshed/).length).toBe(2);
    // Nothing is wrong, so nothing warns.
    expect(has("Not refreshed since")).toBe(false);
    expect(has("have no price")).toBe(false);
    expect(has("Langfuse")).toBe(false);
  });

  test("a stale snapshot, a failing poll and a model with no price each get a sentence", async () => {
    const usage = baseUsage();
    usage.entries[0] = entry({
      source: "inbox",
      usedUsd: 22.5,
      ceilingUsd: 20,
      state: "over",
      stale: true,
      pollError: "statement timeout",
      pollFailedAt: "2026-08-15T12:20:00.000Z",
      unpricedCalls: 10,
      unpricedModels: ["openrouter/free-model"],
    });
    installFetchStub(usage);
    renderCard();
    await waitFor(() => {
      expect(has("Not refreshed since")).toBe(true);
    });
    expect(has("failing since")).toBe(true);
    expect(has("statement timeout")).toBe(true);
    expect(has("10 calls this month have no price")).toBe(true);
    expect(has("openrouter/free-model")).toBe(true);
  });

  // NOTE: the card re-reads on the poll's own period while it stays open. The health beside the bar
  // is the server's per read, so a card left mounted has to ask again, or it keeps saying
  // "refreshed" from its first read across every missed poll.
  test("a mounted card re-reads the usage every poll interval", async () => {
    const usage = { ...baseUsage(), pollIntervalMs: 40 };
    installFetchStub(usage);
    renderCard();
    await waitFor(() => {
      expect(has("$22.50 of $20.00")).toBe(true);
    });
    expect(has("Not refreshed since")).toBe(false);
    // The next read finds both rows gone stale, and both bars say so.
    usage.entries = usage.entries.map((e) => ({ ...e, stale: true }));
    await waitFor(() => {
      expect(
        screen.queryAllByText("Not refreshed since", { exact: false }),
      ).toHaveLength(2);
    });
    const reads = requests.filter(
      (q) => q.method === "GET" && q.path.endsWith("/usage"),
    ).length;
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  // NOTE: a negative amount is refused, not rounded to zero. Zero means no ceiling on that half, so
  // storing it for "-1" would switch the protection off in silence; the field says why and the save
  // waits until the amount is one the ceiling can take.
  test("a negative amount cannot be saved, and the field says why", async () => {
    installFetchStub(baseUsage());
    renderCard();
    await waitFor(() => {
      expect(has("$22.50 of $20.00")).toBe(true);
    });
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    const inbox = inputs[0] as HTMLInputElement;
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    fireEvent.change(inbox, { target: { value: "-1" } });
    expect(has("zero or a positive amount")).toBe(true);
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
    fireEvent.change(inbox, { target: { value: "12" } });
    expect(has("zero or a positive amount")).toBe(false);
    expect(save.disabled).toBe(false);
  });

  // NOTE: nothing read yet is said: until the first poll lands the gate lets every call through,
  // and "$0 of $20" with nothing beside it reads as an enforcing ceiling at zero.
  test("a month nobody has polled yet says so beside the bar", async () => {
    const usage = baseUsage();
    usage.entries[0] = entry({
      source: "inbox",
      ceilingUsd: 20,
      polledAt: null,
      stale: true,
    });
    installFetchStub(usage);
    renderCard();
    await waitFor(() => {
      expect(has("has not been read yet")).toBe(true);
    });
    expect(has("failing since")).toBe(false);
  });

  // With the ceiling off the figure is the ledger summed on the read: it stands alone, says nothing
  // about a gate that is not there, and still names the calls it leaves out.
  test("with the ceiling off the figure stands alone, with no sentence about enforcement", async () => {
    const now = new Date().toISOString();
    const usage = {
      ...baseUsage(),
      enabled: false,
      entries: [
        entry({
          source: "inbox",
          usedUsd: 3.97,
          polledAt: now,
          unpricedCalls: 15,
          unpricedModels: ["gpt-6-luna"],
        }),
        entry({ source: "playground", polledAt: now }),
      ],
    };
    installFetchStub(usage);
    renderCard({ ...settings, enabled: false });
    await waitFor(() => {
      expect(has("$3.97")).toBe(true);
    });
    expect(has("(no ceiling)")).toBe(false);
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(has("calls go through")).toBe(false);
    expect(has("Refreshed")).toBe(false);
    // What stays true without a ceiling is still said.
    expect(has("15 calls this month have no price")).toBe(true);
    expect(has("gpt-6-luna")).toBe(true);
  });

  // NOTE: the settings' explicit null wins. After a save in dollars the settings say
  // `legacyTokens: null`; a usage response read before that save still carries the marker, and a
  // `??` would let it revive a notice about a ceiling that IS enforced.
  test("the settings' explicit null retires the token notice whatever an older usage says", async () => {
    const usage = baseUsage();
    usage.legacyTokens = { inbox: 250_000, playground: 1 } as unknown as null;
    installFetchStub(usage);
    renderCard({ ...settings, legacyTokens: null });
    await waitFor(() => {
      expect(has("$22.50 of $20.00")).toBe(true);
    });
    expect(has("set in tokens")).toBe(false);
  });

  test("a block written in tokens says it is not enforced", async () => {
    installFetchStub(baseUsage());
    renderCard({
      ...settings,
      legacyTokens: { inbox: 250_000, playground: 0 },
    });
    await waitFor(() => {
      expect(has("set in tokens")).toBe(true);
    });
    expect(has("250,000")).toBe(true);
  });

  test("the inputs take cents, and the save sends dollars", async () => {
    installFetchStub(baseUsage());
    renderCard();
    await waitFor(() => {
      expect(has("$22.50 of $20.00")).toBe(true);
    });
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    const inbox = inputs[0] as HTMLInputElement;
    expect(inbox.step).toBe("0.01");
    fireEvent.change(inbox, { target: { value: "45.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === "PUT")).toBe(true);
    });
    const put = requests.find((r) => r.method === "PUT");
    expect(put?.body).toMatchObject({
      monthlyInboxUsd: 45.5,
      monthlyPlaygroundUsd: 0,
    });
    expect(put?.body).not.toHaveProperty("monthlyInboxTokens");
  });

  // NOTE: the dollar fields are edited as text. A number parsed on every keystroke and written back
  // as the field's value turns a cleared field into "0" before the next digit lands, so typing 5
  // over it reads "05", and a trailing point is left to the browser's own heuristic. The text is
  // what the field shows; the number is what the save sends.
  test("a cleared dollar field stays cleared, and what was typed is what is sent", async () => {
    installFetchStub(baseUsage());
    renderCard();
    await waitFor(() => {
      expect(has("$22.50 of $20.00")).toBe(true);
    });
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    const inbox = inputs[0] as HTMLInputElement;
    fireEvent.change(inbox, { target: { value: "" } });
    expect(inbox.value).toBe("");
    fireEvent.change(inbox, { target: { value: "5" } });
    expect(inbox.value).toBe("5");
    fireEvent.change(inbox, { target: { value: "5.25" } });
    expect(inbox.value).toBe("5.25");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === "PUT")).toBe(true);
    });
    expect(requests.find((r) => r.method === "PUT")?.body).toMatchObject({
      monthlyInboxUsd: 5.25,
    });
  });
});
