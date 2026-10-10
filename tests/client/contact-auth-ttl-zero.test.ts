import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import {
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// A typed zero must not serialize as the default where the reader's floor is something else.
// `contactAuth.grantTtlSeconds` IS how long an authorization counts: a typed 0 stored as 86400 would
// reuse an approval for a day, while passed through it is clamped by the reader to its 60-second
// floor. A cleared field is not a request for the shortest reuse, it is a request for the default.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function savedTtl(typed: string): Promise<unknown> {
  const stub = stubEditorApi({
    settings: {
      contactAuth: {
        enabled: true,
        url: "https://auth.example.com/check",
        mode: "once",
        grantTtlSeconds: 3600,
      },
    },
  });
  await renderEditor(stub, "behavior");
  fireEvent.change(
    screen.getByRole("spinbutton", { name: /Reuse the answer for/ }),
    {
      target: { value: typed },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
  const block = lastSavedSettings(stub)?.contactAuth as
    | Record<string, unknown>
    | undefined;
  return block?.grantTtlSeconds;
}

describe("the grant TTL a save writes", () => {
  test("zero is passed through, not replaced by the default", async () => {
    expect(await savedTtl("0")).toBe(0);
  });

  test("an emptied field saves the default", async () => {
    expect(await savedTtl("")).toBe(86_400);
  });

  test("and the reader is what decides what zero means", () => {
    expect(
      readContactAuthConfig({ contactAuth: { grantTtlSeconds: 0 } })
        .grantTtlSeconds,
    ).toBe(60);
  });
});
