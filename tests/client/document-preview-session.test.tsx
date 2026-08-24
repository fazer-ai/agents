/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useDocumentPreview } from "@/client/pages/resources/documents/useDocumentPreview";

// The preview is keyed on the EDITING SESSION, not on the template.
//
// The request is debounced by 600 ms, so whatever the previous session produced stays on screen
// until the next response lands. Keyed on the template id that reads as correct and does nothing in
// the case that matters: an operator edits a template, cancels, and reopens the SAME one — the id
// has not changed, so the discarded draft's PDF is what they read while typing the new one.
//
// The call site is now protected by the compiler (`session` is a required number, and a template id
// is a string), so what is left to prove here is the rule itself: a new session drops the previous
// document AT ONCE, without waiting for the request that replaces it.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

let minted = 0;
URL.createObjectURL = () => `blob:preview-${++minted}`;
URL.revokeObjectURL = () => {};
// Swappable, so the stale-error test below can hand back a refusal whose BODY it holds open.
let respond: () => Promise<unknown> = async () =>
  new Response(new Blob(["%PDF-1.7"]), {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  });
const okResponse = respond;
globalThis.fetch = (async () => respond()) as unknown as typeof fetch;

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

let reopen: () => void = () => {};
let seen: string | null = null;
let seenError: string | null = null;

function Harness() {
  const [session, setSession] = useState(1);
  reopen = () => setSession((s) => s + 1);
  const preview = useDocumentPreview({ name: "Orçamento" }, session);
  seen = preview.url;
  seenError = preview.error;
  return <span data-testid="url">{preview.url ?? "none"}</span>;
}

describe("useDocumentPreview", () => {
  test("a new session drops the previous document before the next one arrives", async () => {
    const view = render(<Harness />);
    await waitFor(
      () => {
        expect(view.getByTestId("url").textContent).toBe("blob:preview-1");
      },
      { timeout: 3000 },
    );

    // Reopening the modal on the same template: same draft, new session. The document has to be
    // gone on the very next paint, not 600 ms later when the replacement request resolves.
    act(() => {
      reopen();
    });
    expect(seen).toBeNull();
    expect(view.getByTestId("url").textContent).toBe("none");

    // …and the replacement does arrive, so the reset is a reset and not a teardown.
    await waitFor(
      () => {
        expect(view.getByTestId("url").textContent).toBe("blob:preview-2");
      },
      { timeout: 3000 },
    );
  });

  // Reading the body is a SECOND await, and the session can change during it. The success path
  // re-checks after `res.blob()`; the refusal path did not after `res.json()`, so a validation error
  // about the draft the operator just left would land in the new session and sit there — naming a
  // block they have already fixed — until the newer request answered.
  test("a refusal whose body arrives after the session changed is dropped", async () => {
    let releaseBody: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      releaseBody = r;
    });
    respond = async () => ({
      ok: false,
      status: 400,
      json: async () => {
        await held;
        return { error: 'block "corpo" is empty' };
      },
    });

    const view = render(<Harness />);
    // The refusal's headers are in; its body is not.
    await waitFor(
      () => {
        expect(releaseBody !== undefined).toBe(true);
      },
      { timeout: 3000 },
    );
    await new Promise((r) => setTimeout(r, 800));

    // The operator reopens on a new session, and only THEN does the old body finish parsing.
    act(() => {
      reopen();
    });
    respond = okResponse;
    releaseBody?.();
    await new Promise((r) => setTimeout(r, 50));

    // The stale refusal never reaches the screen, and the new session's document does.
    expect(seenError).toBeNull();
    await waitFor(
      () => {
        expect(view.getByTestId("url").textContent?.startsWith("blob:")).toBe(
          true,
        );
      },
      { timeout: 3000 },
    );
  });
});
