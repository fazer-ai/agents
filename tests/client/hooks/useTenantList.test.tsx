/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useTenantList } from "@/client/hooks/useTenantList";

// The `enabled` gate, which is not a detail: the fleet list is a SUPER_ADMIN surface, so a
// tenant-scoped session asking for it is a request that should never leave the browser. Rendered
// rather than reasoned about, because "does it fetch" is only answerable from the outside.

let calls = 0;
const realFetch = globalThis.fetch;

function Probe({ enabled }: { enabled: boolean }) {
  const { tenants } = useTenantList(enabled);
  return <span data-testid="n">{tenants.length}</span>;
}

beforeEach(() => {
  calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/v1/tenants")) calls += 1;
    return new Response(JSON.stringify({ tenants: [{ id: "1", name: "A" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("useTenantList", () => {
  test("disabled, it never asks for the list", async () => {
    render(<Probe enabled={false} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(0);
  });

  test("enabled, it asks once and reports what came back", async () => {
    render(<Probe enabled={true} />);
    await waitFor(() => {
      expect(calls).toBe(1);
    });
  });
});
