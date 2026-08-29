/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AlertChannelsSection } from "@/client/components/alerts/AlertChannelsSection";
import { ToastProvider } from "@/client/components/Toast";
import { invalidateVault } from "@/client/lib/vaultCache";

// The edit modal sends `secretRef` on EVERY save, and the service reads a null there as "clear it".
// So whatever the modal holds when the operator presses Save is what the channel keeps — which makes
// the field the form loads on open the whole story. Opening a signed channel and saving it unchanged
// is the shape under test: it is not a no-op, it unsigns the channel, and the console shows nothing.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const VAULT_ENTRY = {
  id: "7",
  name: "ops-hmac",
  kind: "generic",
  baseUrl: null,
  paramName: null,
  status: "active",
};

function channel(over: Record<string, unknown> = {}) {
  return {
    id: "3",
    name: "Ops webhook",
    type: "webhook",
    urlMasked: "https://ops.example.com/…",
    enabled: true,
    minLevel: "error",
    stages: [],
    hasSecret: true,
    secretRef: "vault:7",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("AlertChannelsSection", () => {
  // Stubbing `globalThis.fetch` rather than the api module: `mock.module` is global to the process
  // and leaks into whatever else shares the worker. The stub is process-global too, in a different
  // way, so every call is recorded WITH its url and the assertions look up the one the form is
  // responsible for — a stray request from elsewhere lands in `calls` where it can be named instead
  // of overwriting the answer (the lesson `BusinessHoursForm.test.tsx` carries).
  const realFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  let channels: ReturnType<typeof channel>[] = [];

  const patches = () =>
    calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/alert-channels/"),
    );

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const method = String(init?.method ?? "GET");
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes("/api/v1/vault")) return json({ entries: [VAULT_ENTRY] });
    if (url.includes("/api/v1/alert-channels")) {
      if (method === "GET") return json({ channels });
      return json({ channel: channels[0] });
    }
    return json({});
  }) as unknown as typeof globalThis.fetch;

  beforeEach(() => {
    invalidateVault();
    channels = [channel()];
  });
  afterEach(() => {
    cleanup();
    calls.length = 0;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const openEditor = async () => {
    render(
      <ToastProvider>
        <AlertChannelsSection />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.queryAllByText("Ops webhook").length > 0).toBe(true),
    );
    screen.getByRole("button", { name: /^(Edit|Editar)$/ }).click();
    await waitFor(() =>
      expect(
        screen.queryAllByRole("button", { name: /^(Save|Salvar)$/ }).length,
      ).toBe(1),
    );
  };

  const save = async () => {
    screen.getByRole("button", { name: /^(Save|Salvar)$/ }).click();
    await waitFor(() => expect(patches().length).toBe(1));
    return patches()[0]?.body as Record<string, unknown>;
  };

  test("a save that changed nothing keeps the channel signed", async () => {
    await openEditor();
    const body = await save();
    // The whole defect in one line: `null` here is the service's spelling of "clear it".
    expect(JSON.stringify(body?.secretRef)).toBe(JSON.stringify("vault:7"));
  });

  test("the modal says WHICH credential signs, not just that one does", async () => {
    await openEditor();
    // The list badge only ever said "Signed". The picker resolving the ref to its vault entry is
    // what lets the operator see, and keep, the credential they configured.
    await waitFor(() =>
      expect(screen.queryAllByText("ops-hmac").length > 0).toBe(true),
    );
  });

  test("an unsigned channel still saves as unsigned", async () => {
    channels = [channel({ hasSecret: false, secretRef: null })];
    await openEditor();
    const body = await save();
    // The other half of the prefill: blank has to keep meaning "no secret", so that a channel
    // without one is not handed a stale ref from the component's last session.
    expect(JSON.stringify(body?.secretRef)).toBe(JSON.stringify(null));
  });
});
