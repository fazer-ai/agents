/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { StaleBuildWatcher } from "@/client/components/StaleBuildBanner";
import { NavGuardProvider } from "@/client/contexts/NavGuardContext";
import { api, onApiResponse } from "@/client/lib/api";
import { resetBuildWatch } from "@/client/lib/staleBuild";
import { hasUnsavedChanges } from "@/client/lib/unsavedGuard";
import { until } from "../utils/poll";

// A stale tab reloads itself at the next change of screen, which aborts whatever the console has on
// the wire. A write the server may already have applied (a password change, whose answer carries the
// replacement session cookie) must finish first, whichever screen started it and whether or not that
// screen is still mounted. So every write through the console's API client holds the reload until
// its answer has been read; a read holds nothing.
//
// NOTE: assertions reduce to numbers or booleans before expect; a failing expectation holding a DOM
// node serializes a cyclic happy-dom tree and stalls the runner.

const OWN = "9.9.1+a";
const NEWER = "9.9.2+b";

type Pending = {
  method: string;
  url: string;
  answer: (body?: BodyInit | null) => void;
  fail: () => void;
};
let pending: Pending[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init?.method ?? "GET").toUpperCase();
  return new Promise<Response>((resolve, reject) => {
    pending.push({
      method,
      url,
      answer: (body = "{}") =>
        resolve(
          new Response(body, {
            headers: {
              "content-type": "application/json",
              "x-app-build": NEWER,
              "x-app-version": "9.9.2",
            },
          }),
        ),
      fail: () => reject(new TypeError("Failed to fetch")),
    });
  });
}) as typeof fetch;

let reloads = 0;
const reloadSpy = spyOn(window.location, "reload").mockImplementation(() => {
  reloads++;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  reloadSpy.mockRestore();
  resetBuildWatch();
});

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {to}
    </button>
  );
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/settings/security"]}>
      <NavGuardProvider>
        <StaleBuildWatcher />
        <GoTo to="/settings/profile" />
        <GoTo to="/agents" />
      </NavGuardProvider>
    </MemoryRouter>,
  );
}

const go = (to: string) =>
  fireEvent.click(screen.getByRole("button", { name: to }));

const becomeStale = () =>
  act(() =>
    onApiResponse(
      new Response(null, {
        headers: { "x-app-build": NEWER, "x-app-version": "9.9.2" },
      }),
    ),
  );

async function onTheWire(method: string) {
  return until(`a ${method} on the wire`, () =>
    pending.find((p) => p.method === method),
  );
}

beforeEach(() => {
  resetBuildWatch(OWN);
  reloads = 0;
  pending = [];
});
afterEach(async () => {
  // Nothing left on the wire for the next test: an unanswered write would keep holding.
  for (const p of pending) p.answer();
  pending = [];
  cleanup();
  await until("every hold released", () => !hasUnsavedChanges());
});

describe("a write in flight holds the stale tab's reload", () => {
  test("a password change in flight and a change of screen do not reload; once answered, the next change does", async () => {
    renderShell();
    becomeStale();
    const change = api.api.auth.password.patch({
      currentPassword: "old-password",
      newPassword: "new-password-1234",
    });
    const wire = await onTheWire("PATCH");
    go("/settings/profile");
    const whileInFlight = reloads;
    wire.answer();
    await change;
    go("/agents");
    expect([whileInFlight, reloads]).toEqual([0, 1]);
  });

  test("any write holds it, not only the password: a DELETE", async () => {
    renderShell();
    becomeStale();
    const removal = api.api.admin.invitations({ id: "inv-1" }).delete();
    const wire = await onTheWire("DELETE");
    go("/settings/profile");
    const whileInFlight = reloads;
    wire.answer();
    await removal;
    go("/agents");
    expect([whileInFlight, reloads]).toEqual([0, 1]);
  });

  test("a write that fails on the network releases the hold", async () => {
    renderShell();
    becomeStale();
    const change = api.api.auth.password.patch({
      currentPassword: "old-password",
      newPassword: "new-password-1234",
    });
    const wire = await onTheWire("PATCH");
    wire.fail();
    await change;
    go("/settings/profile");
    expect(reloads).toBe(1);
  });

  test("the hold lasts until the answer's body is read, not just its headers", async () => {
    renderShell();
    becomeStale();
    let finish = () => {};
    let reading = false;
    // highWaterMark 0: nothing is pulled until the client starts reading, which is how the test knows
    // the headers already reached it.
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          finish = () => {
            controller.enqueue(new TextEncoder().encode('{"ok":true}'));
            controller.close();
          };
        },
        pull() {
          reading = true;
        },
      },
      { highWaterMark: 0 },
    );
    const change = api.api.auth.password.patch({
      currentPassword: "old-password",
      newPassword: "new-password-1234",
    });
    const wire = await onTheWire("PATCH");
    wire.answer(body);
    await until("the client reading the answer", () => reading);
    go("/settings/profile");
    const whileReading = reloads;
    finish();
    await change;
    go("/agents");
    expect([whileReading, reloads]).toEqual([0, 1]);
  });

  test("a read in flight holds nothing", async () => {
    renderShell();
    becomeStale();
    void api.api.health.get();
    await onTheWire("GET");
    go("/settings/profile");
    expect(reloads).toBe(1);
  });
});
