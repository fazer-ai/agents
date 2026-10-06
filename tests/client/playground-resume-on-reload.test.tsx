/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import {
  NO_USAGE,
  PLAYGROUND_RESUME_KEY,
  usePlaygroundChat,
} from "@/client/pages/agents/usePlaygroundChat";

// Opening an agent's screen starts a new session; only a reload of a tab that had a session open
// brings it back. The reload is told apart by a per-tab marker written on `pagehide`, which in-app
// navigation never fires, and consumed by the next mount.

const AGENT = "7";
const LATEST = "1:playground:7:latest";
const OLDER = "1:playground:7:older";

const realFetch = globalThis.fetch;
const realSessionStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
);
let opened: string[] = [];

function server() {
  opened = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = String(req ? req.url : input);
    const method = (req ? req.method : init?.method) ?? "GET";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/playground/sessions") && method === "GET")
      return json({
        sessions: [
          { threadId: LATEST, title: "latest", updatedAt: "2026-10-06" },
          { threadId: OLDER, title: "older", updatedAt: "2026-10-01" },
        ],
      });
    const one = url.match(/\/playground\/sessions\/([^/]+)$/);
    if (one && method === "GET") {
      const tid = decodeURIComponent(one[1] ?? "");
      opened.push(tid);
      return json({
        threadId: tid,
        usage: NO_USAGE,
        turns: [{ role: "user", text: `in ${tid}`, trace: [], sources: [] }],
      });
    }
    if (url.endsWith("/playground/threads"))
      return json({ threadId: "1:playground:7:fresh" });
    if (url.endsWith("/playground") && method === "POST")
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    return json({});
  }) as typeof fetch;
}

function mark(agentId: string, threadId: string, href = location.href) {
  sessionStorage.setItem(
    PLAYGROUND_RESUME_KEY,
    JSON.stringify({ agentId, threadId, href }),
  );
}

// How this document was loaded, as the browser's navigation entry reports it.
const realEntries = performance.getEntriesByType.bind(performance);
function loadedAs(type: "reload" | "navigate", name = location.href) {
  performance.getEntriesByType = ((t: string) =>
    t === "navigation"
      ? [{ type, name }]
      : realEntries(t)) as typeof performance.getEntriesByType;
}

async function mount(opts: { strict?: boolean } = {}) {
  const hook = renderHook(() => usePlaygroundChat(AGENT, false), {
    ...(opts.strict ? { wrapper: StrictMode } : {}),
  });
  // The session list is the last thing the mount loads either way.
  await waitFor(() => expect(hook.result.current.sessions).toHaveLength(2));
  return hook;
}

function shownText(hook: Awaited<ReturnType<typeof mount>>) {
  return hook.result.current.turns.map((x) =>
    x.role === "user" ? x.text : x.role,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  loadedAs("reload");
  server();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  performance.getEntriesByType = realEntries;
  // NOTE: Restored here and not in the test's finally: a rejection from the mount ends the test
  // before its finally runs, and a throwing store would leak into every file after this one.
  if (realSessionStorage)
    Object.defineProperty(globalThis, "sessionStorage", realSessionStorage);
  sessionStorage.clear();
});

describe("which session the agent screen opens on", () => {
  test("in-app navigation opens a new session, with the history still listed", async () => {
    const hook = await mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
    expect(hook.result.current.currentThreadId).toBeUndefined();
    expect(hook.result.current.turns).toEqual([]);
  });

  test("a reload with a session open brings that session back, not the latest", async () => {
    mark(AGENT, OLDER);
    const hook = await mount();
    await waitFor(() => expect(shownText(hook)).toEqual([`in ${OLDER}`]));
    expect(hook.result.current.currentThreadId).toBe(OLDER);
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).toBeNull();
  });

  test("the marker is used once: the next mount opens a new session", async () => {
    mark(AGENT, OLDER);
    const first = await mount();
    await waitFor(() =>
      expect(first.result.current.currentThreadId).toBe(OLDER),
    );
    first.unmount();
    opened = [];
    const second = await mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
    expect(second.result.current.currentThreadId).toBeUndefined();
  });

  test("a document reached by typing a URL is not a reload: new session, marker dropped", async () => {
    mark(AGENT, OLDER);
    loadedAs("navigate");
    const hook = await mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
    expect(hook.result.current.currentThreadId).toBeUndefined();
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).toBeNull();
  });

  test("a reload of another page, after the editor left for it, opens a new session", async () => {
    mark(AGENT, OLDER, "http://localhost:3000/agents/7/playground");
    loadedAs("reload", "http://localhost:3000/agents");
    const hook = await mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
    expect(hook.result.current.currentThreadId).toBeUndefined();
  });

  test("a marker left by another agent opens a new session and is dropped", async () => {
    mark("8", "1:playground:8:x");
    const hook = await mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
    expect(hook.result.current.currentThreadId).toBeUndefined();
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).toBeNull();
  });

  test("under StrictMode the cancelled first run does not spend the marker", async () => {
    mark(AGENT, OLDER);
    const hook = await mount({ strict: true });
    await waitFor(() =>
      expect(hook.result.current.currentThreadId).toBe(OLDER),
    );
    expect(shownText(hook)).toEqual([`in ${OLDER}`]);
  });

  test("storage that throws on access falls back to a new session", async () => {
    mark(AGENT, OLDER);
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    const hook = await mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
    expect(hook.result.current.currentThreadId).toBeUndefined();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
  });
});

describe("what pagehide leaves for the reload", () => {
  test("a saved session open is written down for this agent", async () => {
    mark(AGENT, OLDER);
    const hook = await mount();
    await waitFor(() =>
      expect(hook.result.current.currentThreadId).toBe(OLDER),
    );
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(
      JSON.parse(sessionStorage.getItem(PLAYGROUND_RESUME_KEY) ?? "null"),
    ).toEqual({ agentId: AGENT, threadId: OLDER, href: location.href });
  });

  test("a new session that never sent leaves nothing", async () => {
    await mount();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).toBeNull();
  });

  test("a first turn that failed has a thread but no saved session, and leaves nothing", async () => {
    const hook = await mount();
    await act(async () => {
      hook.result.current.setInput("oi");
    });
    await act(async () => {
      await hook.result.current.send();
    });
    expect(hook.result.current.currentThreadId).toBe("1:playground:7:fresh");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).toBeNull();
  });

  test("after leaving the agent screen in-app, a pagehide elsewhere leaves nothing", async () => {
    mark(AGENT, OLDER);
    const hook = await mount();
    await waitFor(() =>
      expect(hook.result.current.currentThreadId).toBe(OLDER),
    );
    hook.unmount();
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).toBeNull();
  });

  test("a page restored from the back-forward cache drops the marker it wrote", async () => {
    mark(AGENT, OLDER);
    const hook = await mount();
    await waitFor(() =>
      expect(hook.result.current.currentThreadId).toBe(OLDER),
    );
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).not.toBeNull();
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => {
      window.dispatchEvent(restored);
    });
    expect(sessionStorage.getItem(PLAYGROUND_RESUME_KEY)).toBeNull();
  });
});
