/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useCompanyLogoUrl } from "@/client/pages/resources/documents/useCompanyLogoUrl";

// The letterhead arrives in two awaits — the response, then its body — and the card is unmounted or
// re-keyed between them often enough to matter: switching the active tenant, uploading a new logo.
// Minting the object URL before the second check hands it to a cleanup that already ran and found
// nothing, so it stays pinned for the life of the tab AND the stale response paints the previous
// tenant's letterhead over the current one.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

let minted = 0;
let live = new Set<string>();
// Held open so the test decides WHEN the body resolves, which is the whole window under test.
type Release = (() => void) | null;
let releaseBody: Release = null;

URL.createObjectURL = () => {
  const url = `blob:logo-${++minted}`;
  live.add(url);
  return url;
};
URL.revokeObjectURL = (url: string) => {
  live.delete(url);
};
// What the next request answers: "ok", a refusal, or a transport failure.
let answer: "ok" | "refused" | "throws" = "ok";
globalThis.fetch = (async () => {
  if (answer === "throws") throw new Error("offline");
  return {
    ok: answer === "ok",
    // NOTE: present because `mediaFetch` reads them: a refused tenant selector is answered by a
    // header, and a double that omits it makes the recovery throw inside every media load.
    headers: new Headers(),
    blob: async () => {
      await new Promise<void>((resolve) => {
        releaseBody = resolve;
      });
      return new Blob(["png"]);
    },
  };
}) as unknown as typeof fetch;

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

function Harness({
  logoKey,
  version = 1,
}: {
  logoKey: string | null;
  version?: number;
}) {
  const url = useCompanyLogoUrl(logoKey, version);
  return <span data-testid="url">{url ?? "none"}</span>;
}

describe("useCompanyLogoUrl", () => {
  test("a response that lands after unmount mints nothing", async () => {
    minted = 0;
    live = new Set();
    releaseBody = null;
    answer = "ok";
    const view = render(<Harness logoKey="1-logo.png" />);
    await waitFor(() => {
      expect((releaseBody as Release) !== null).toBe(true);
    });
    // The tenant switches (or the card goes away) while the body is still in flight.
    view.unmount();
    (releaseBody as Release)?.();
    // Nothing to revoke, because nothing was minted: the URL is not created until after the check.
    await waitFor(() => {
      expect(minted).toBe(0);
    });
    expect(live.size).toBe(0);
  });

  test("a response that lands while mounted shows the logo", async () => {
    minted = 0;
    live = new Set();
    releaseBody = null;
    answer = "ok";
    const view = render(<Harness logoKey="1-logo.png" />);
    await waitFor(() => {
      expect((releaseBody as Release) !== null).toBe(true);
    });
    (releaseBody as Release)?.();
    await waitFor(() => {
      expect(view.getByTestId("url").textContent).toBe("blob:logo-1");
    });
    // …and unmounting then gives the URL back rather than pinning its bytes for the tab's life.
    view.unmount();
    expect(live.size).toBe(0);
  });

  // A REPLACEMENT must not keep showing the old one. The previous run's cleanup already revoked
  // that blob URL, so leaving it in state while the new request is in flight points the <img> at
  // bytes the browser has released — and if the request never succeeds, it points there for good.
  test("a new version drops the revoked URL before the replacement arrives", async () => {
    minted = 0;
    live = new Set();
    releaseBody = null;
    answer = "ok";
    const view = render(<Harness logoKey="1-logo.png" version={1} />);
    await waitFor(() => {
      expect((releaseBody as Release) !== null).toBe(true);
    });
    (releaseBody as Release)?.();
    await waitFor(() => {
      expect(view.getByTestId("url").textContent).toBe("blob:logo-1");
    });

    releaseBody = null;
    view.rerender(<Harness logoKey="1-logo.png" version={2} />);
    // Nothing is shown while the replacement loads, rather than a URL that has been revoked.
    expect(view.getByTestId("url").textContent).toBe("none");
    expect(live.has("blob:logo-1")).toBe(false);
    await waitFor(() => {
      expect((releaseBody as Release) !== null).toBe(true);
    });
    (releaseBody as Release)?.();
    await waitFor(() => {
      expect(view.getByTestId("url").textContent).toBe("blob:logo-2");
    });
  });

  // A refusal and a transport failure are the same state to a reader: there is nothing to show. The
  // failure must not be an unhandled rejection next to a card that looks merely slow.
  test("a refused or failed request leaves nothing showing", async () => {
    for (const outcome of ["refused", "throws"] as const) {
      minted = 0;
      live = new Set();
      releaseBody = null;
      answer = outcome;
      const view = render(<Harness logoKey="1-logo.png" />);
      await waitFor(() => {
        expect(view.getByTestId("url").textContent).toBe("none");
      });
      expect(minted).toBe(0);
      view.unmount();
    }
  });

  // No key means no request and no picture: the card renders its placeholder.
  test("no logo configured asks for nothing", async () => {
    minted = 0;
    releaseBody = null;
    answer = "ok";
    const view = render(<Harness logoKey={null} />);
    expect(view.getByTestId("url").textContent).toBe("none");
    expect(releaseBody as Release).toBeNull();
  });
});
