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
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import {
  StaleBuildBanner,
  StaleBuildWatcher,
} from "@/client/components/StaleBuildBanner";
import {
  NavGuardProvider,
  useNavGuard,
} from "@/client/contexts/NavGuardContext";
import { onApiResponse } from "@/client/lib/api";
import { importWithReload, resetBuildWatch } from "@/client/lib/staleBuild";
import { useBeforeUnload, useHeldDraft } from "@/client/lib/unsavedGuard";

// A tab loaded before a deploy learns it from the next response, says so in the shell with a Reload,
// and reloads on its own at the next route change unless something is unsaved.
//
// NOTE: assertions reduce to a boolean or a string BEFORE expect; a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

const OWN = "9.9.1+a";
const realFetch = globalThis.fetch;
let servedBuild = "9.9.2+b";
let healthCalls = 0;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/health")) healthCalls++;
  return new Response("{}", {
    headers: {
      "content-type": "application/json",
      "x-app-build": servedBuild,
      "x-app-version": servedBuild.split("+")[0] ?? "",
    },
  });
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
  resetBuildWatch();
});

let reloads = 0;
const reloadSpy = spyOn(window.location, "reload").mockImplementation(() => {
  reloads++;
});
afterAll(() => reloadSpy.mockRestore());

function GoTo({ to, label = "go" }: { to: string; label?: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}
function HeldDraft() {
  useHeldDraft(true);
  return null;
}
function DirtyPage() {
  useNavGuard(true);
  return null;
}
function DirtyModal() {
  useBeforeUnload(true);
  return null;
}

function renderShell(extra?: React.ReactNode, at = "/agents") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <NavGuardProvider>
        <StaleBuildWatcher />
        <StaleBuildBanner />
        <GoTo to="/conversations" />
        {extra}
      </NavGuardProvider>
    </MemoryRouter>,
  );
}

const serverAnswers = (build: string) =>
  onApiResponse(
    new Response(null, {
      headers: {
        "x-app-build": build,
        "x-app-version": build.split("+")[0] ?? "",
      },
    }),
  );

const bannerText = () => screen.queryByRole("status")?.textContent ?? null;

beforeEach(() => {
  resetBuildWatch(OWN);
  reloads = 0;
  healthCalls = 0;
  servedBuild = "9.9.2+b";
  sessionStorage.clear();
});
afterEach(() => cleanup());

describe("the stale-build banner", () => {
  test("stays away while the server serves this tab's build", () => {
    renderShell();
    act(() => serverAnswers(OWN));
    expect(bannerText()).toBeNull();
  });

  test("appears on the first response from another build, naming its version", () => {
    renderShell();
    act(() => serverAnswers("9.9.2+b"));
    expect(bannerText()).toContain("v9.9.2");
  });

  test("Reload reloads the page", () => {
    renderShell();
    act(() => serverAnswers("9.9.2+b"));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reloads).toBe(1);
  });

  test("Reload with unsaved changes asks first, and reloads only on discard", () => {
    renderShell(<DirtyPage />);
    act(() => serverAnswers("9.9.2+b"));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const askedBeforeReload = reloads === 0 && !!screen.queryByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    // The operator already chose to discard, so the browser's own unload prompt must not ask again.
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect([askedBeforeReload, reloads, unload.defaultPrevented]).toEqual([
      true,
      1,
      false,
    ]);
  });

  test("a window focus asks the server, which is how an idle tab finds out", async () => {
    renderShell();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(bannerText()).toContain("v9.9.2"));
    expect(healthCalls).toBe(1);
  });

  test("focus right after focus does not ask again", async () => {
    renderShell();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(bannerText()).not.toBeNull());
    expect(healthCalls).toBe(1);
  });
});

describe("the reload on a route change", () => {
  test("reloads a stale tab when the operator moves to another screen", () => {
    renderShell();
    act(() => serverAnswers("9.9.2+b"));
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(reloads).toBe(1);
  });

  test("a filter or search that changes only the query does not reload", () => {
    renderShell(
      <>
        <GoTo to="/agents?level=warn" label="filter" />
        <GoTo to="/agents?level=warn&q=a" label="search" />
        <GoTo to="/agents?level=warn&q=a#row" label="anchor" />
      </>,
    );
    act(() => serverAnswers("9.9.2+b"));
    fireEvent.click(screen.getByRole("button", { name: "filter" }));
    fireEvent.click(screen.getByRole("button", { name: "search" }));
    fireEvent.click(screen.getByRole("button", { name: "anchor" }));
    const afterQuery = reloads;
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect([afterQuery, reloads]).toEqual([0, 1]);
  });

  test("a change of screen does not reload over an unsent draft", () => {
    renderShell(
      <>
        <HeldDraft />
        <GoTo to="/agents/5/general" label="tab" />
      </>,
      "/agents/5/playground",
    );
    act(() => serverAnswers("9.9.2+b"));
    fireEvent.click(screen.getByRole("button", { name: "tab" }));
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect([reloads, bannerText() !== null]).toEqual([0, true]);
  });

  test("once the draft is gone the next change of screen reloads", () => {
    function Draft() {
      const { pathname } = useLocation();
      return pathname.endsWith("/playground") ? <HeldDraft /> : null;
    }
    renderShell(
      <>
        <Draft />
        <GoTo to="/agents/5/general" label="tab" />
      </>,
      "/agents/5/playground",
    );
    act(() => serverAnswers("9.9.2+b"));
    fireEvent.click(screen.getByRole("button", { name: "tab" }));
    expect(reloads).toBe(1);
  });

  test("never reloads by itself before the route changes", () => {
    renderShell();
    act(() => serverAnswers("9.9.2+b"));
    expect(reloads).toBe(0);
  });

  test("a shell that mounts on an already stale tab waits for a route change", () => {
    act(() => serverAnswers("9.9.2+b"));
    renderShell();
    expect(reloads).toBe(0);
  });

  test("leaves a current tab alone", () => {
    renderShell();
    act(() => serverAnswers(OWN));
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(reloads).toBe(0);
  });

  test("does not reload while a modal holds unsaved changes", () => {
    renderShell(<DirtyModal />);
    act(() => serverAnswers("9.9.2+b"));
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect([reloads, bannerText() !== null]).toEqual([0, true]);
  });
});

describe("a dynamic import that fails", () => {
  const missingChunk = () =>
    Promise.reject(
      new TypeError("Failed to fetch dynamically imported module"),
    );

  test("reloads the page once and never settles while it does", async () => {
    let settled = false;
    importWithReload(missingChunk).then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect([reloads, settled]).toEqual([1, false]);
  });

  test("surfaces the error instead of reloading over unsaved changes", async () => {
    renderShell(<DirtyModal />);
    const error = await importWithReload(missingChunk).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect([reloads, error]).toEqual([
      0,
      "Failed to fetch dynamically imported module",
    ]);
  });

  test("surfaces the error instead of reloading over an unsent draft", async () => {
    renderShell(<HeldDraft />);
    const error = await importWithReload(missingChunk).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect([reloads, error]).toEqual([
      0,
      "Failed to fetch dynamically imported module",
    ]);
  });

  test("surfaces the error when this build already reloaded once", async () => {
    importWithReload(missingChunk).catch(() => {});
    await Promise.resolve();
    const error = await importWithReload(missingChunk).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect([reloads, error]).toEqual([
      1,
      "Failed to fetch dynamically imported module",
    ]);
  });
});
