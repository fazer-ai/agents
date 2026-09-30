/// <reference lib="dom" />

// A Google sign-in on the login page has to land where the page decided (a validated `?redirect=`,
// or the MCP authorize endpoint, which only a real browser navigation reaches). The hook navigating
// to "/" on its own unmounts the page before it can, and the destination is lost.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

const logins: unknown[] = [];

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ login: (user: unknown) => logins.push(user) }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useGoogleSignIn } = await import("@/client/hooks/useGoogleSignIn");

const USER = { id: "1", email: "a@example.com", name: "A", role: "ADMIN" };
const realFetch = globalThis.fetch;

function Harness({ onSignedIn }: { onSignedIn?: () => void }) {
  const { signIn } = useGoogleSignIn({ onError: () => {}, onSignedIn });
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={() => void signIn("credential")}>
        sign in
      </button>
      <output>{location.pathname}</output>
    </>
  );
}

function renderAt(onSignedIn?: () => void) {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="*" element={<Harness onSignedIn={onSignedIn} />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function clickSignIn(view: ReturnType<typeof renderAt>) {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "sign in" }));
  });
}

describe("useGoogleSignIn", () => {
  beforeEach(() => {
    logins.length = 0;
    globalThis.fetch = (async () =>
      Response.json({ user: USER })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });

  test("hands the landing to the caller instead of navigating to /", async () => {
    let calls = 0;
    const view = renderAt(() => {
      calls += 1;
    });
    await clickSignIn(view);
    expect(logins).toEqual([USER]);
    expect(calls).toBe(1);
    expect(view.getByRole("status").textContent).toBe("/login");
  });

  test("lands on / when the caller has no destination of its own", async () => {
    const view = renderAt();
    await clickSignIn(view);
    expect(logins).toEqual([USER]);
    expect(view.getByRole("status").textContent).toBe("/");
  });
});
