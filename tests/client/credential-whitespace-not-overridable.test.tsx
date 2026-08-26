/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// A failed connection test relabels Save to "Save anyway", because a probe can fail for reasons the
// operator is entitled to overrule: a provider that is down, an endpoint we cannot reach from here.
//
// `surrounding_whitespace` is not one of them. It is the WRITE's verdict, reported early by the
// probe, and `createVaultEntry`/`updateVaultEntry` refuse it every time — so "Save anyway" advertises
// an action that cannot succeed, on the one failure the operator cannot see for themselves (#338).
//
// NOTE: `globalThis.fetch` is swapped rather than `mock.module`, whose restore is global to the
// process and tears down other files' mocks. Assertions reduce to a string or a boolean BEFORE
// expect: a failing expectation holding a DOM node serializes a cyclic happy-dom tree and stalls.

const { CredentialForm } = await import("@/client/components/CredentialForm");
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;

function serveProbe(body: unknown): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    if (url.includes("/v1/vault/test")) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "1", ref: "vault:1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

// Returns the Save button's label AND whether clicking it wrote, because the label and the handler
// are two different reads of the same condition: a fix that only relabels still fires save(true).
async function probeWith(
  body: unknown,
): Promise<{ label: string; wrote: boolean }> {
  const seen = serveProbe(body);
  const { container } = render(
    <ToastProvider>
      <CredentialForm
        mode="create"
        initialKind="openai"
        onSaved={() => {}}
        onCancel={() => {}}
      />
    </ToastProvider>,
  );
  const value = container.querySelector('input[type="password"]');
  if (!value) throw new Error("no secret input rendered");
  fireEvent.change(value, { target: { value: " sk-secret\n" } });
  fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
  await waitFor(() => {
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    if (!labels.some((l) => /save/i.test(l))) throw new Error("no save button");
  });
  const save = screen
    .getAllByRole("button")
    .find((b) => /save/i.test(b.textContent ?? ""));
  const label = save?.textContent ?? "";
  seen.length = 0;
  if (save) fireEvent.click(save);
  await waitFor(() => {
    if (seen.length === 0) throw new Error("the click issued no request");
  });
  return { label, wrote: seen.some((u) => /\/v1\/vault(\?|$)/.test(u)) };
}

test("a whitespace verdict neither offers Save anyway nor writes", async () => {
  const { label, wrote } = await probeWith({
    testable: true,
    ok: false,
    code: "surrounding_whitespace",
  });
  expect(/anyway/i.test(label)).toBe(false);
  expect(wrote).toBe(false);
});

test("an ordinary connection failure still offers it, and it writes", async () => {
  const { label, wrote } = await probeWith({
    testable: true,
    ok: false,
    code: "unreachable",
  });
  expect(/anyway/i.test(label)).toBe(true);
  expect(wrote).toBe(true);
});
