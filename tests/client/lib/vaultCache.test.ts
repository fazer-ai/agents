import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { setActiveTenantId } from "@/client/lib/activeTenant";
import {
  invalidateVault,
  loadVault,
  refreshVault,
  useVaultBaseUrls,
  VAULT_CHANGED_EVENT,
} from "@/client/lib/vaultCache";

// Stub the global fetch (the Eden treaty calls it) instead of mocking the api module — a mock.module
// would leak to every other test file in the shared process. We count GET /vault hits and control the
// active tenant with the real setActiveTenantId (localStorage, provided by happy-dom).
const realFetch = globalThis.fetch;
let getCalls = 0;
let entriesToReturn: Array<{
  id: string;
  name: string;
  kind: string | null;
  baseUrl?: string;
}> = [];

beforeEach(() => {
  invalidateVault();
  setActiveTenantId(null);
  getCalls = 0;
  entriesToReturn = [{ id: "1", name: "openai", kind: "openai" }];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/vault")) {
      getCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ entries: entriesToReturn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo | URL);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("vaultCache", () => {
  test("dedups concurrent loads into a single fetch", async () => {
    const [a, b, c] = await Promise.all([
      loadVault(),
      loadVault(),
      loadVault(),
    ]);
    expect(getCalls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toHaveLength(1);
  });

  test("serves from cache within the TTL", async () => {
    await loadVault();
    await loadVault();
    expect(getCalls).toBe(1);
  });

  test("refreshVault forces a refetch and emits the change event", async () => {
    await loadVault();
    let fired = 0;
    const h = () => {
      fired++;
    };
    window.addEventListener(VAULT_CHANGED_EVENT, h);
    await refreshVault();
    window.removeEventListener(VAULT_CHANGED_EVENT, h);
    expect(getCalls).toBe(2);
    expect(fired).toBe(1);
  });

  test("invalidateVault drops the cache (next load refetches) and emits", async () => {
    await loadVault();
    let fired = 0;
    const h = () => {
      fired++;
    };
    window.addEventListener(VAULT_CHANGED_EVENT, h);
    invalidateVault();
    expect(fired).toBe(1);
    await loadVault();
    window.removeEventListener(VAULT_CHANGED_EVENT, h);
    expect(getCalls).toBe(2);
  });

  test("keys by active tenant so it never serves another tenant's vault", async () => {
    setActiveTenantId("10");
    await loadVault();
    setActiveTenantId("20");
    await loadVault();
    expect(getCalls).toBe(2);
    // Back to tenant 10 → still cached (no extra fetch).
    setActiveTenantId("10");
    await loadVault();
    expect(getCalls).toBe(2);
  });
});

// A credential's endpoint has to be readable by the PAGE, not only by the picker that displays it.
// The agent editor renders one tab at a time and judges the whole configuration on every one of
// them: while it read this off a CredentialPicker's callback, an editor opened straight on Behavior
// never mounted General, so the model credential's endpoint did not exist as far as the page was
// concerned and the speech rewrite was declared endpoint-less on a configuration that runs.
describe("useVaultBaseUrls", () => {
  test("resolves a ref's endpoint with no picker mounted", async () => {
    entriesToReturn = [
      {
        id: "7",
        name: "llama",
        kind: "openai",
        baseUrl: "http://llama:8080/v1",
      },
      { id: "8", name: "openai", kind: "openai" },
    ];
    const { result } = renderHook(() => useVaultBaseUrls());
    await waitFor(() =>
      expect(result.current("vault:7")).toBe("http://llama:8080/v1"),
    );
    // An entry without one, an unknown ref and no ref at all are the same answer: nothing to
    // override the typed field with.
    expect(result.current("vault:8")).toBeNull();
    expect(result.current("vault:404")).toBeNull();
    expect(result.current("")).toBeNull();
    cleanup();
  });

  test("follows the vault when it changes underneath", async () => {
    entriesToReturn = [{ id: "7", name: "llama", kind: "openai" }];
    const { result } = renderHook(() => useVaultBaseUrls());
    await waitFor(() => expect(getCalls).toBe(1));
    expect(result.current("vault:7")).toBeNull();
    entriesToReturn = [
      {
        id: "7",
        name: "llama",
        kind: "openai",
        baseUrl: "http://llama:8080/v1",
      },
    ];
    await act(async () => {
      await refreshVault();
    });
    await waitFor(() =>
      expect(result.current("vault:7")).toBe("http://llama:8080/v1"),
    );
    cleanup();
  });
});
