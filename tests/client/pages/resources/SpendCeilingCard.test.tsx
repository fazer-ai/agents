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

// The spend ceiling's card shows DOLLARS as Langfuse costed them, and beside the bar the health of
// the figure and the reconciliation against the ledger (issue #426): a ceiling that undercounts, a
// snapshot nobody refreshed, a block written in tokens, a tenant with no Langfuse — each has a
// sentence on this screen, because this is the screen that shows the bar.

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
  tracedCalls: number;
  costedCalls: number;
  ledgerCalls: number;
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
  tracedCalls: 0,
  costedCalls: 0,
  ledgerCalls: 0,
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
  periodStart: "2026-08-01T00:00:00.000Z",
  langfuseConfigured: true,
  legacyTokens: null,
  pollIntervalMs: 300_000,
  entries: [
    entry({
      source: "inbox",
      usedUsd: 22.5,
      ceilingUsd: 20,
      state: "over",
      tracedCalls: 40,
      costedCalls: 40,
      ledgerCalls: 40,
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
    expect(has("undercounts")).toBe(false);
    expect(has("No price in Langfuse")).toBe(false);
    expect(has("Langfuse is not configured")).toBe(false);
  });

  test("a stale snapshot, a failing poll and a model with no price each get a sentence", async () => {
    const usage = baseUsage();
    usage.entries[0] = entry({
      source: "inbox",
      usedUsd: 22.5,
      ceilingUsd: 20,
      state: "over",
      stale: true,
      pollError: "Langfuse metrics API responded with 502",
      pollFailedAt: "2026-08-15T12:20:00.000Z",
      tracedCalls: 38,
      costedCalls: 30,
      ledgerCalls: 40,
      unpricedModels: ["openrouter/free-model"],
    });
    installFetchStub(usage);
    renderCard();
    await waitFor(() => {
      expect(has("Not refreshed since")).toBe(true);
    });
    expect(has("failing since")).toBe(true);
    expect(has("responded with 502")).toBe(true);
    expect(has("priced 30 of the 40 calls")).toBe(true);
    expect(has("openrouter/free-model")).toBe(true);
  });

  // NOTHING READ IS SAID (review round 5): until the first poll lands the gate lets every call
  // through, and "$0 of $20" with nothing beside it reads as an enforcing ceiling at zero.
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

  // THE SETTINGS' EXPLICIT NULL WINS (review round 5). After a save in dollars the settings say
  // `legacyTokens: null`; a usage response that resolved after that save but was read before it
  // still carries the marker, and `??` let it revive a notice about a ceiling that IS enforced.
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

  test("a tenant with no Langfuse is told the ceiling cannot be enforced", async () => {
    const usage = { ...baseUsage(), langfuseConfigured: false };
    usage.entries = usage.entries.map((e) => ({
      ...e,
      polledAt: null,
      pollError: "langfuse-not-configured",
      pollFailedAt: "2026-08-15T12:00:00.000Z",
    }));
    installFetchStub(usage);
    renderCard();
    await waitFor(() => {
      expect(has("Langfuse is not configured")).toBe(true);
    });
    // The reason is said once, above the bars, not as a "failing since" line per bar.
    expect(has("failing since")).toBe(false);
  });

  // The two reads can disagree for a poll: the flag is computed on the request, the sentinel was
  // written by the last poll. Either one is enough to say the ceiling cannot be enforced.
  test("a row carrying the not-configured sentinel says so even when the flag disagrees", async () => {
    const usage = baseUsage();
    usage.entries = usage.entries.map((e) => ({
      ...e,
      pollError: "langfuse-not-configured",
      pollFailedAt: "2026-08-15T12:00:00.000Z",
    }));
    installFetchStub(usage);
    renderCard();
    await waitFor(() => {
      expect(has("Langfuse is not configured")).toBe(true);
    });
    expect(has("failing since")).toBe(false);
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

  // THE DOLLAR FIELDS ARE EDITED AS TEXT (review round 4). A number parsed on every keystroke and
  // written back as the field's value turns a cleared field into "0" before the next digit lands,
  // so typing 5 over it reads "05", and hands a trailing point back to the browser's own heuristic.
  // The text is what the field shows; the number is what the save sends.
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
