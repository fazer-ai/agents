import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import {
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// A typed zero must not serialize as the default: `contactAuth.grantTtlSeconds` IS how long an
// authorization counts, and a 0 stored as 86400 would reuse an approval for a day. The field holds Save
// below its 60-second floor instead, so the zero never leaves. A cleared field is not a
// request for the shortest reuse, it is a request for the default.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function typeTtl(typed: string) {
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
  return stub;
}

describe("the grant TTL a save writes", () => {
  test("zero holds Save instead of being saved as a day", async () => {
    await typeTtl("0");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  test("an emptied field saves the default", async () => {
    const stub = await typeTtl("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
    const block = lastSavedSettings(stub)?.contactAuth as
      | Record<string, unknown>
      | undefined;
    expect(block?.grantTtlSeconds).toBe(86_400);
  });

  test("and the reader is what decides what zero means", () => {
    expect(
      readContactAuthConfig({ contactAuth: { grantTtlSeconds: 0 } })
        .grantTtlSeconds,
    ).toBe(60);
  });
});
