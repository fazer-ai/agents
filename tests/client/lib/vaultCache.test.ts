import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { setActiveTenantId } from "@/client/lib/activeTenant";
import {
  invalidateVault,
  loadVault,
  refreshVault,
  useVaultBaseUrls,
  useVaultRefs,
  VAULT_CHANGED_EVENT,
} from "@/client/lib/vaultCache";

// Stub the global fetch (the Eden treaty calls it) instead of mocking the api module — a mock.module
// would leak to every other test file in the shared process. We count GET /vault hits and control the
// active tenant with the real setActiveTenantId (localStorage, provided by happy-dom).
const realFetch = globalThis.fetch;
let getCalls = 0;
// Flips one response to a server error, to separate "the vault is empty" from "the vault did not
// load" — the treaty reports both with an empty `data`.
let failNext = false;
let failAll = false;
// Holds responses open so an EARLIER request can finish after a later one. Each hold is claimed by
// the next request to start, in order, and released by its index; the body is snapshot at claim
// time, which is the point — a held request answers with the vault as it was when it left.
type Hold = { promise: Promise<unknown>; release: () => void; fail?: boolean };
let queuedHolds: Hold[] = [];
let claimedHolds: Hold[] = [];
function holdNextResponse(opts?: { fail?: boolean }): void {
  let release = (): void => undefined;
  const promise = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  queuedHolds.push({ promise, release, fail: opts?.fail });
}
function releaseHeld(index: number): void {
  claimedHolds[index]?.release();
}
let entriesToReturn: Array<{
  id: string;
  name: string;
  kind: string | null;
  baseUrl?: string;
  status?: string;
}> = [];

beforeEach(() => {
  invalidateVault();
  setActiveTenantId(null);
  getCalls = 0;
  failNext = false;
  failAll = false;
  queuedHolds = [];
  claimedHolds = [];
  entriesToReturn = [{ id: "1", name: "openai", kind: "openai" }];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/vault")) {
      getCalls++;
      const snapshot = entriesToReturn;
      const hold = queuedHolds.shift();
      if (hold) {
        claimedHolds.push(hold);
        await hold.promise;
        return new Response(
          JSON.stringify(hold.fail ? { error: "boom" } : { entries: snapshot }),
          {
            status: hold.fail ? 500 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      await new Promise((r) => setTimeout(r, 5));
      if (failNext || failAll) {
        failNext = false;
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
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

  // Two announcements, one refetch. The first says the list in hand is stale — it goes out before
  // the request, because that gap is when a listener would otherwise answer from a vault that has
  // already changed — and the second says the replacement has arrived. Listeners re-read on both,
  // and the second re-read is served from the cache, which is why this still costs one GET.
  test("refreshVault forces a refetch and brackets it with change events", async () => {
    await loadVault();
    let fired = 0;
    const h = () => {
      fired++;
    };
    window.addEventListener(VAULT_CHANGED_EVENT, h);
    await refreshVault();
    window.removeEventListener(VAULT_CHANGED_EVENT, h);
    expect(getCalls).toBe(2);
    expect(fired).toBe(2);
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

// Which refs the vault currently holds, and which of those are still unfilled. Both answers come off
// the same list, and the page needs them whether or not the field that displays them is mounted —
// the editor renders one tab at a time.
describe("useVaultRefs", () => {
  test("holds `known` at null until the first list arrives", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    const { result } = renderHook(() => useVaultRefs());
    // The state that matters: before the response, "nothing is known" must not read as "nothing
    // resolves". An empty set here would light up every credential on the page for one paint.
    expect(result.current.known).toBeNull();
    expect(result.current.pending.size).toBe(0);
    await waitFor(() =>
      expect(result.current.known?.has("vault:3")).toBe(true),
    );
    cleanup();
  });

  test("separates filled entries from the ones still awaiting a secret", async () => {
    entriesToReturn = [
      { id: "3", name: "openai", kind: "openai" },
      { id: "4", name: "eleven", kind: "elevenlabs", status: "pending" },
    ];
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() => expect(result.current.known?.size).toBe(2));
    // A pending entry EXISTS: it is known AND pending, and the two answers are used for different
    // fixes (fill it in place vs pick another key).
    expect(result.current.known?.has("vault:4")).toBe(true);
    expect([...result.current.pending]).toEqual(["vault:4"]);
    expect(result.current.pendingEntries.map((e) => e.id)).toEqual(["4"]);
    cleanup();
  });

  test("follows a deletion made elsewhere on the page", async () => {
    entriesToReturn = [
      { id: "3", name: "openai", kind: "openai" },
      { id: "9", name: "gone", kind: "openai" },
    ];
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() => expect(result.current.known?.size).toBe(2));
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    await act(async () => {
      await refreshVault();
    });
    await waitFor(() =>
      expect(result.current.known?.has("vault:9")).toBe(false),
    );
    cleanup();
  });
});

// A vault that failed to load is UNKNOWN, not empty. The treaty resolves a non-2xx with `data:
// null` instead of rejecting, so without an explicit check the failure would arrive as an empty
// list — and an empty list means "no credential resolves", which would flag every field on the page
// as deleted on a transient 500.
describe("a failed vault load", () => {
  test("rejects instead of resolving to an empty list", async () => {
    failNext = true;
    expect(loadVault()).rejects.toThrow();
  });

  test("leaves useVaultRefs at not-loaded", async () => {
    failNext = true;
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() => expect(getCalls).toBe(1));
    expect(result.current.known).toBeNull();
    cleanup();
  });
});

// The same ref can be written more than one way and mean the same entry, and the endpoint lookup is
// judged by the speech rewrite: a padded id reading as "no endpoint" would declare a runnable
// rewrite dead.
describe("useVaultBaseUrls with a noncanonical ref", () => {
  test("resolves a padded id to the same entry", async () => {
    entriesToReturn = [
      {
        id: "7",
        name: "llama",
        kind: "openai",
        baseUrl: "http://llama:8080/v1",
      },
    ];
    const { result } = renderHook(() => useVaultBaseUrls());
    await waitFor(() =>
      expect(result.current("vault:7")).toBe("http://llama:8080/v1"),
    );
    expect(result.current("vault:0007")).toBe("http://llama:8080/v1");
    // A name is not a ref: no id can be read out of it, and no resolver matches it.
    expect(result.current("llama")).toBeNull();
    cleanup();
  });
});

// A refresh that fails leaves the listeners holding a list the cache no longer has, and the caller
// has usually just CHANGED the vault (created or filled a credential) and pointed a field at the
// result. Staying quiet there means the editor keeps answering from a list that predates the change
// — a credential created a moment ago reading as deleted.
describe("a failed refreshVault", () => {
  test("sends listeners back to the vault, which heals a transient failure", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() =>
      expect(result.current.known?.has("vault:3")).toBe(true),
    );
    // What the caller just did: created entry 9 and pointed a field at it. The refresh that would
    // have delivered it fails; the re-read that the notification triggers succeeds.
    entriesToReturn = [
      { id: "3", name: "openai", kind: "openai" },
      { id: "9", name: "fresh", kind: "openai" },
    ];
    failNext = true;
    await act(async () => {
      await refreshVault().catch(() => undefined);
    });
    await waitFor(() =>
      expect(result.current.known?.has("vault:9")).toBe(true),
    );
    cleanup();
  });

  test("leaves them at not-loaded when the vault stays down", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() =>
      expect(result.current.known?.has("vault:3")).toBe(true),
    );
    failAll = true;
    await act(async () => {
      await refreshVault().catch(() => undefined);
    });
    // Not the stale list, which is what silence would have left behind: a credential the operator
    // just created reading as deleted.
    await waitFor(() => expect(result.current.known).toBeNull());
    failAll = false;
    cleanup();
  });
});

// Every vault mutation in the app funnels through `invalidateVault` or `refreshVault`, and both
// announce it. From the announcement until the replacement list lands, the list in hand is known to
// predate the change — and the caller has usually just created the credential a field now points
// at. Answering "the vault does not hold this ref" from that list is how a credential created a
// second ago reads as deleted, so the answer is withheld for the length of the request.
describe("useVaultRefs across a vault change", () => {
  test("stops answering from the pre-change list until the new one lands", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() =>
      expect(result.current.known?.has("vault:3")).toBe(true),
    );
    // What a create does: the entry exists in the vault, the field already points at it, and the
    // list in hand is the one from before.
    entriesToReturn = [
      { id: "3", name: "openai", kind: "openai" },
      { id: "9", name: "just-created", kind: "openai" },
    ];
    // The real path every mutation takes: the cache is dropped and the listeners are told, in that
    // order (VaultPanel's delete and the editor's credential-fill modal both call exactly this).
    act(() => {
      invalidateVault();
    });
    // Mid-flight: no claim either way about vault:9.
    expect(result.current.known).toBeNull();
    await waitFor(() =>
      expect(result.current.known?.has("vault:9")).toBe(true),
    );
    cleanup();
  });
});

// Clearing the in-flight map does not cancel the request it was tracking. A load that started
// BEFORE the vault changed is still on the wire, and if it lands last it describes the vault as it
// was: it would overwrite both the shared cache and the listener with pre-mutation data, and the
// credential just created would read as deleted until something else moved.
describe("a load overtaken by a vault change", () => {
  test("discards the answer that describes the vault as it was", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    holdNextResponse();
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() => expect(getCalls).toBe(1));
    // The vault changes while that first read is still on the wire.
    entriesToReturn = [
      { id: "3", name: "openai", kind: "openai" },
      { id: "9", name: "just-created", kind: "openai" },
    ];
    await act(async () => {
      invalidateVault();
    });
    await waitFor(() =>
      expect(result.current.known?.has("vault:9")).toBe(true),
    );
    // Now the overtaken read lands, carrying the list from before the change.
    await act(async () => {
      releaseHeld(0);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.known?.has("vault:9")).toBe(true);
    // And it did not poison the shared cache for everyone else either.
    const cached = await loadVault();
    expect(cached.map((e) => e.id).sort()).toEqual(["3", "9"]);
    cleanup();
  });
});

// The in-flight entry belongs to the read that set it, and a read that FAILS is the case where that
// matters: an overtaken read that succeeds settles only once its replacement lands (it hands the
// caller that newer answer), while a rejection is immediate and lands mid-flight. Clearing the map
// there would evict the entry of the read still on the wire, and the next caller to arrive would
// fire a third request for a list already coming — the whole reason this cache exists.
describe("the in-flight entry while a superseded load fails", () => {
  test("survives the failure of the read it replaced", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    holdNextResponse({ fail: true });
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() => expect(getCalls).toBe(1));
    holdNextResponse();
    await act(async () => {
      invalidateVault();
    });
    await waitFor(() => expect(getCalls).toBe(2));
    // The overtaken read fails now, while the current one is still on the wire.
    await act(async () => {
      releaseHeld(0);
      await new Promise((r) => setTimeout(r, 10));
    });
    // A newcomer joins that read instead of starting another. The tick matters: the request would
    // only reach the stub on the next turn, so asserting immediately would pass either way.
    const joined = loadVault();
    await new Promise((r) => setTimeout(r, 10));
    expect(getCalls).toBe(2);
    await act(async () => {
      releaseHeld(1);
      await joined;
    });
    expect(result.current.known?.has("vault:3")).toBe(true);
    cleanup();
  });
});

// The two orderings a refresh can take, and both used to end with the panel answering from
// something that is not the current vault.
describe("refreshVault while listeners are watching", () => {
  test("tells them the moment it drops the list, not when the new one lands", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() =>
      expect(result.current.known?.has("vault:3")).toBe(true),
    );
    // The picker's create: the entry exists, the field already points at it, and this refresh is
    // what will deliver it. Until it does, the list in hand is the one from before.
    entriesToReturn = [
      { id: "3", name: "openai", kind: "openai" },
      { id: "9", name: "just-created", kind: "openai" },
    ];
    holdNextResponse();
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = refreshVault().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.known).toBeNull();
    await act(async () => {
      releaseHeld(0);
      await pending;
    });
    await waitFor(() =>
      expect(result.current.known?.has("vault:9")).toBe(true),
    );
    cleanup();
  });
});

// A superseded read is irrelevant whether it succeeded or FAILED: its 500 says nothing about the
// vault the caller is asking about. Reported as the caller's own failure, it drove the listener to
// not-loaded on top of the fresh list that had already arrived, and nothing would come along to put
// it back — the panel silent about pending and dangling credentials until the next reload.
describe("a superseded read that fails after the fresh one landed", () => {
  test("does not erase the answer that replaced it", async () => {
    entriesToReturn = [{ id: "3", name: "openai", kind: "openai" }];
    holdNextResponse({ fail: true });
    const { result } = renderHook(() => useVaultRefs());
    await waitFor(() => expect(getCalls).toBe(1));
    entriesToReturn = [
      { id: "3", name: "openai", kind: "openai" },
      { id: "9", name: "just-created", kind: "openai" },
    ];
    holdNextResponse();
    await act(async () => {
      invalidateVault();
    });
    await waitFor(() => expect(getCalls).toBe(2));
    // The replacement lands first...
    await act(async () => {
      releaseHeld(1);
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() =>
      expect(result.current.known?.has("vault:9")).toBe(true),
    );
    // ...and then the read it replaced fails.
    await act(async () => {
      releaseHeld(0);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.known?.has("vault:9")).toBe(true);
    cleanup();
  });
});
