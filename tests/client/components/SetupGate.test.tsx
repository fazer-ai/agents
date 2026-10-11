/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import * as AuthModule from "@/client/contexts/AuthContext";
import { stubExports } from "@/tests/utils/module-stub";

let authState: { user: { email: string } | null; setupRequired: boolean };

stubExports(AuthModule, {
  useAuth: () => authState,
});

const { SetupGate } = await import("@/client/components/SetupGate");

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SetupGate>
        <Routes>
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/setup" element={<div>SETUP</div>} />
          <Route path="/login" element={<div>LOGIN</div>} />
          <Route path="/secret" element={<div>SECRET</div>} />
        </Routes>
      </SetupGate>
    </MemoryRouter>,
  );
}

describe("SetupGate", () => {
  beforeEach(() => {
    authState = { user: null, setupRequired: false };
  });

  afterEach(() => {
    cleanup();
  });

  test("redirects anonymous traffic to /setup while setup is required", () => {
    authState = { user: null, setupRequired: true };
    renderAt("/secret");
    expect(screen.getByText("SETUP")).toBeDefined();
    expect(screen.queryByText("SECRET")).toBeNull();
  });

  test("renders /setup itself without looping when setup is required", () => {
    authState = { user: null, setupRequired: true };
    renderAt("/setup");
    expect(screen.getByText("SETUP")).toBeDefined();
  });

  test("does not send a signed-in user to /setup even if the flag is stale", () => {
    // NOTE: Regression guard for the post-setup redirect loop: right after the
    // setup auto-login, setupRequired may still be true in context.
    authState = { user: { email: "admin@fazer.ai" }, setupRequired: true };
    renderAt("/");
    expect(screen.getByText("HOME")).toBeDefined();
    expect(screen.queryByText("SETUP")).toBeNull();
  });

  test("bounces off /setup to /login once setup is complete (anonymous)", () => {
    authState = { user: null, setupRequired: false };
    renderAt("/setup");
    expect(screen.getByText("LOGIN")).toBeDefined();
  });

  test("sends an authenticated visitor of /setup straight to / (no /login hop)", () => {
    authState = { user: { email: "admin@fazer.ai" }, setupRequired: false };
    renderAt("/setup");
    expect(screen.getByText("HOME")).toBeDefined();
    expect(screen.queryByText("LOGIN")).toBeNull();
  });

  test("renders normally once setup is complete", () => {
    authState = { user: null, setupRequired: false };
    renderAt("/secret");
    expect(screen.getByText("SECRET")).toBeDefined();
  });
});
