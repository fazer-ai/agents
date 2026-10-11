/// <reference lib="dom" />

import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { resetServerClock } from "@/client/lib/serverClock";
import enLocale from "@/client/locales/en.json";
import { debugModesFrom } from "@/modules/flowlog/debug-mode";
import {
  FULL_DETAIL_ARM_HOURS,
  FULL_DETAIL_MAX_HOURS,
  readObservabilityConfig,
} from "@/modules/flowlog/settings";
import {
  type EditorStub,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The Behavior tab's debug window, as the operator sees it: the warning says what the SERVER is
// recording (the saved config and the tenant's Langfuse switch, never the form), the full-detail
// switch holds the form's own deadline, both stop claiming the mode once their deadline passes with
// nothing clicked, and every instant is the server's, learned from the `Date` of its responses.

const HOUR = 3_600_000;
const realFetch = globalThis.fetch;
afterEach(() => {
  jest.useRealTimers();
  cleanup();
  globalThis.fetch = realFetch;
  resetServerClock();
});

const WARNING = /Recording more than the default right now:/;
const fullDetailSwitch = () =>
  screen.getByRole("switch", { name: /Store log detail in full/ });
const toolValuesSwitch = () =>
  screen.getByRole("switch", { name: /Log the values sent to tools/ });
const warning = () => screen.queryByText(WARNING)?.textContent ?? null;
const checked = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";
// The sentence under the switch, as text: which deadline it names, and whether it waits on a save.
const hint = () => {
  const text = screen.queryByText(/^On until /)?.textContent ?? null;
  if (text === null) return null;
  return text.endsWith(" once you save.") ? "unsaved" : "saved";
};

// The server's clock, `skewMs` off the browser's, stamped as `Date` on the responses `stamped` picks.
function serverClock(
  skewMs: number,
  stamped: (path: string) => boolean = () => true,
) {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner(input, init);
    const path = new URL(String(input), "http://localhost").pathname;
    if (!stamped(path)) return response;
    const headers = new Headers(response.headers);
    headers.set("date", new Date(Date.now() + skewMs).toUTCString());
    return new Response(await response.text(), {
      status: response.status,
      headers,
    });
  }) as typeof fetch;
}

async function openBehavior(
  observability: Record<string, unknown> = {},
  setup: (stub: EditorStub) => void = () => {},
): Promise<EditorStub> {
  const stub = stubEditorApi({ settings: { observability } });
  setup(stub);
  await renderEditor(stub, "behavior");
  return stub;
}

const advance = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });

describe("the warning speaks for what the server records", () => {
  test("a switch turned on in the form is not reported until it is saved", async () => {
    await openBehavior();
    expect(warning()).toBeNull();
    fireEvent.click(toolValuesSwitch());
    fireEvent.click(fullDetailSwitch());
    await act(async () => {});
    expect(warning()).toBeNull();
  });

  test("a saved switch turned off in the form is still reported", async () => {
    await openBehavior({ logToolValues: true });
    expect(warning()).toContain("tool values");
    fireEvent.click(toolValuesSwitch());
    await act(async () => {});
    expect(checked(toolValuesSwitch())).toBe(false);
    expect(warning()).toContain("tool values");
  });

  test("each switch alone lights it, under its own name", async () => {
    await openBehavior({ logToolValues: true });
    expect(warning()).toMatch(/: tool values$/);
    cleanup();

    await openBehavior({
      fullDetailUntil: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(warning()).toMatch(/: full log detail$/);
    cleanup();

    await openBehavior({}, (stub) => {
      stub.override = (method, path) =>
        method === "GET" && path === "/api/v1/tenant-settings"
          ? Response.json({
              embedding: { credentialRef: null },
              langfuse: { sendContent: true },
            })
          : undefined;
    });
    await waitFor(() =>
      expect(warning()).toMatch(/: content sent to Langfuse$/),
    );
  });

  test("the tenant's switch is read apart from the editor's load, so it can neither hold nor break it", async () => {
    let answer: (r: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    await openBehavior({}, (stub) => {
      stub.override = (method, path) =>
        method === "GET" && path === "/api/v1/tenant-settings"
          ? held
          : undefined;
    });
    expect(fullDetailSwitch().isConnected).toBe(true);
    await act(async () => answer(new Response("refused", { status: 500 })));
    expect(fullDetailSwitch().isConnected).toBe(true);
    expect(warning()).toBeNull();
  });
});

describe("the windows close on their own", () => {
  test("the saved window and the form's each stop being claimed at their own deadline", async () => {
    await openBehavior({
      fullDetailUntil: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    expect(warning()).toContain("full log detail");
    expect(checked(fullDetailSwitch())).toBe(true);
    // The deadline on screen is the saved one, so nothing waits on a save.
    expect(hint()).toBe("saved");

    jest.useFakeTimers();
    // Re-armed in the form: a later deadline than the saved one, which only a save applies.
    fireEvent.click(fullDetailSwitch());
    expect(checked(fullDetailSwitch())).toBe(false);
    expect(hint()).toBe(null);
    fireEvent.click(fullDetailSwitch());
    expect(checked(fullDetailSwitch())).toBe(true);
    expect(hint()).toBe("unsaved");

    await advance(2 * HOUR + 1_000);
    expect(warning()).toBeNull();
    expect(checked(fullDetailSwitch())).toBe(true);

    await advance((FULL_DETAIL_ARM_HOURS - 2) * HOUR);
    expect(checked(fullDetailSwitch())).toBe(false);
    expect(hint()).toBe(null);
  });

  test("a window armed long after the editor opened is judged at the moment it was armed", async () => {
    await openBehavior();
    jest.useFakeTimers();
    await advance(13 * HOUR);
    fireEvent.click(fullDetailSwitch());
    await act(async () => {});
    expect(checked(fullDetailSwitch())).toBe(true);
    expect(hint()).toBe("unsaved");
  });
});

// The deadline is chosen in the browser and enforced by the server, so every instant here is the
// server's: a browser clock hours off would arm a window of another length, or read a running one as
// over (and the next save of any Behavior field would then write that `null` back).
describe("the window is on the server's clock, not the browser's", () => {
  test("arming stores the armed length from the server's now", async () => {
    const skew = 3 * HOUR;
    const stub = await openBehavior({}, () => serverClock(skew));
    fireEvent.click(fullDetailSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
    const saved = lastSavedSettings(stub)?.observability as
      | { fullDetailUntil: string }
      | undefined;
    const until = Date.parse(String(saved?.fullDetailUntil));
    const expected = Date.now() + skew + FULL_DETAIL_ARM_HOURS * HOUR;
    expect(Math.abs(until - expected)).toBeLessThan(5_000);
  });

  test("a saved window still running on the server reads as running with the browser ahead", async () => {
    const skew = -2 * HOUR;
    await openBehavior(
      { fullDetailUntil: new Date(Date.now() + skew + HOUR).toISOString() },
      () => serverClock(skew),
    );
    expect(warning()).toContain("full log detail");
    expect(checked(fullDetailSwitch())).toBe(true);
  });

  test("the offset is learned from an error response too", async () => {
    const skew = -2 * HOUR;
    await openBehavior(
      { fullDetailUntil: new Date(Date.now() + skew + HOUR).toISOString() },
      (stub) => {
        stub.override = (method, path) =>
          method === "GET" && path === "/api/auth/me"
            ? Response.json({ error: "unauthorized" }, { status: 401 })
            : undefined;
        serverClock(skew, (path) => path === "/api/auth/me");
      },
    );
    expect(warning()).toContain("full log detail");
  });

  test("a saved window stops being reported at the server's deadline, with the browser behind or ahead", async () => {
    // Behind first: a timer counted from the browser's now would fire hours late. Ahead: a filter on
    // the browser's now would drop the deadline as already past and arm nothing.
    for (const skew of [3 * HOUR, -2 * HOUR]) {
      await openBehavior(
        { fullDetailUntil: new Date(Date.now() + skew + HOUR).toISOString() },
        () => serverClock(skew),
      );
      expect(warning()).toContain("full log detail");
      jest.useFakeTimers();
      // Re-armed in the form, so the scheduler runs again under the fake clock; the saved deadline
      // is still the earlier one.
      fireEvent.click(fullDetailSwitch());
      fireEvent.click(fullDetailSwitch());
      await advance(HOUR - 60_000);
      expect(warning()).toContain("full log detail");
      await advance(2 * 60_000);
      expect(warning()).toBeNull();
      jest.useRealTimers();
      cleanup();
      globalThis.fetch = realFetch;
      resetServerClock();
    }
  });
});

describe("the derivation the warning goes through", () => {
  test("lights on any one switch", () => {
    const off = readObservabilityConfig({});
    const values = readObservabilityConfig({
      observability: { logToolValues: true },
    });
    const armed = readObservabilityConfig({
      observability: {
        fullDetailUntil: new Date(Date.now() + HOUR).toISOString(),
      },
    });
    expect(debugModesFrom(off, false).any).toBe(false);
    expect(debugModesFrom(values, false).any).toBe(true);
    expect(debugModesFrom(armed, false).any).toBe(true);
    expect(debugModesFrom(off, true).any).toBe(true);
  });

  test("an already-read config is re-judged against the instant it is given", () => {
    const cfg = readObservabilityConfig(
      {
        observability: {
          fullDetailUntil: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      new Date(),
    );
    expect(debugModesFrom(cfg, false, new Date()).fullDetail).toBe(true);
    const later = new Date(Date.now() + 120_000);
    expect(debugModesFrom(cfg, false, later).fullDetail).toBe(false);
    expect(debugModesFrom(cfg, false, later).any).toBe(false);
  });
});

// The console arms for less than the ceiling, and the gap is the skew the reader tolerates.
describe("the armed window against the reader's ceiling", () => {
  test("the armed window is strictly shorter than the bound", () => {
    expect(FULL_DETAIL_ARM_HOURS).toBeLessThan(FULL_DETAIL_MAX_HOURS);
    expect(FULL_DETAIL_ARM_HOURS).toBeGreaterThan(0);
  });

  test("a browser ahead by the whole margin still arms", () => {
    const skew = (FULL_DETAIL_MAX_HOURS - FULL_DETAIL_ARM_HOURS) * HOUR;
    const serverNow = new Date();
    const armed = new Date(
      serverNow.getTime() + skew + FULL_DETAIL_ARM_HOURS * HOUR,
    ).toISOString();
    expect(
      readObservabilityConfig(
        { observability: { fullDetailUntil: armed } },
        serverNow,
      ).fullDetail,
    ).toBe(true);
  });

  test("arming for the ceiling itself would not survive any forward skew", () => {
    const serverNow = new Date();
    const armed = new Date(
      serverNow.getTime() + 1000 + FULL_DETAIL_MAX_HOURS * HOUR,
    ).toISOString();
    expect(
      readObservabilityConfig(
        { observability: { fullDetailUntil: armed } },
        serverNow,
      ).fullDetail,
    ).toBe(false);
  });
});

test("neither sentence promises a save the other one already had", () => {
  const until = enLocale.editor.observabilityFullDetailUntil;
  const unsaved = enLocale.editor.observabilityFullDetailUntilUnsaved;
  expect(until.toLowerCase()).not.toContain("save");
  expect(unsaved).toContain("save");
  // Both name the moment, because both are answering "until when".
  expect(until).toContain("{{when}}");
  expect(unsaved).toContain("{{when}}");
});
