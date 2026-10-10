/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider, useModalController } from "@/client/components";
import { AuthProvider, useAuth } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import {
  forgetToolSample,
  noteOperator,
  recallToolSample,
  rememberToolSample,
  sampleTicket,
} from "@/client/lib/toolSample";
import { ToolEditModal } from "@/client/pages/resources/ToolEditModal";
import { ToolsPanel } from "@/client/pages/resources/ToolsPanel";

// The call sites of `client/lib/toolSample`, rendered: the tool editor's save, its Format button and
// its opening, the Tools page's delete, and the auth context that tells the module whose samples
// these are. The module's own rules are tests/client/tool-sample-persistence.test.ts; what is asked
// here is that the screens hand it the right moment and the right value.

const realFetch = globalThis.fetch;
let who = 0;
beforeEach(() => {
  noteOperator(`editor-op-${who++}`);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  localStorage.clear();
});

const REV1 = "2026-09-07T12:00:00.000Z";
const REV2 = "2026-09-07T13:00:00.000Z";
const RESPONSE = '{"cliente":{"nome":"Ana"}}';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function tool(id: string, url: string, updatedAt = REV1) {
  return {
    id,
    name: `lookup_${id}`,
    label: `Lookup ${id}`,
    description: null,
    method: "GET",
    urlTemplate: url,
    allowedHosts: ["api.example.com"],
    headers: {},
    inputSchema: {},
    outputSchema: {},
    query: {},
    body: {},
    credentialRef: null,
    enabled: true,
    ackEnabled: false,
    ackMessage: null,
    createdAt: REV1,
    updatedAt,
  };
}

// The API behind the editor: two stored tools, a test endpoint answering RESPONSE, and a PATCH that
// can be held open while the test does what another tab would.
function serveEditor() {
  const gate: { hold: boolean; release: () => void; out: boolean } = {
    hold: false,
    release: () => {},
    out: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PATCH" && path === "/api/v1/tools/1") {
      gate.out = true;
      if (gate.hold) await new Promise<void>((r) => (gate.release = r));
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json({
        tool: {
          ...tool("1", body.urlTemplate ?? ""),
          ...body,
          updatedAt: REV2,
        },
      });
    }
    if (method === "POST") {
      return json({
        instance: {},
        result: {
          status: 200,
          durationMs: 1,
          raw: RESPONSE,
          rawChars: RESPONSE.length,
          rawClipped: false,
          modelText: `HTTP 200\n${RESPONSE}`,
          failed: false,
          notes: [],
        },
      });
    }
    if (path === "/api/v1/tools/1") {
      return json({ tool: tool("1", "https://api.example.com/x") });
    }
    if (path === "/api/v1/tools/2") {
      return json({ tool: tool("2", "https://api.example.com/outra") });
    }
    return json({ items: [], entries: [], instances: [] });
  }) as unknown as typeof fetch;
  return gate;
}

function EditorHarness() {
  const modal = useModalController<{ id?: string }>();
  return (
    <MemoryRouter>
      <ToastProvider>
        <button type="button" onClick={() => modal.open({ id: "1" })}>
          open-1
        </button>
        <button type="button" onClick={() => modal.open({ id: "2" })}>
          open-2
        </button>
        <button type="button" onClick={() => modal.close()}>
          close-it
        </button>
        <ToolEditModal modal={modal as never} onSaved={() => undefined} />
      </ToastProvider>
    </MemoryRouter>
  );
}

async function openTool(id: "1" | "2") {
  fireEvent.click(screen.getByText(`open-${id}`));
  await screen.findByDisplayValue(`Lookup ${id}`);
}

// A test request from the editor: the response lands in the sample box, captured against the
// definition on screen.
async function runTest() {
  fireEvent.click(screen.getByRole("button", { name: "Send a test request" }));
  fireEvent.click(await screen.findByText("Send request"));
  await waitFor(() =>
    expect(document.body.textContent?.includes('"nome": "Ana"')).toBe(true),
  );
  const dialogs = screen.getAllByRole("dialog");
  const testDialog = dialogs[dialogs.length - 1] as HTMLElement;
  const close = within(testDialog)
    .getAllByRole("button")
    .find((b) => /^(Close|Cancel)$/.test(b.textContent?.trim() ?? ""));
  if (close) fireEvent.click(close);
  await act(async () => {});
}

// The sample box is a CodeMirror, written by dispatching into its view, found by its accessible name.
function writeSample(text: string): void {
  const content = Array.from(document.querySelectorAll(".cm-content")).find(
    (el) => /sample response/i.test(el.getAttribute("aria-label") ?? ""),
  );
  if (!content) throw new Error("no sample editor on screen");
  const view = EditorView.findFromDOM(
    content.closest(".cm-editor") as HTMLElement,
  ) as EditorView;
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}

function edit(from: string, to: string) {
  fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });
}

const save = () =>
  fireEvent.click(screen.getByText("Save").closest("button") as HTMLElement);

const kept = (id: string, revision = REV2) =>
  recallToolSample(id, revision)?.text ?? null;

describe("the tool editor hands the module the right moment and the right value", () => {
  // The ticket is only worth anything if it is read before the request: a deletion landing while
  // the save is out has to win over it.
  test("reads the ticket before the request rather than at the write", async () => {
    const answered: Record<string, boolean> = {};
    for (const forgotten of [false, true]) {
      const gate = serveEditor();
      gate.hold = true;
      render(<EditorHarness />);
      await openTool("1");
      await runTest();
      edit("Lookup 1", "Lookup 1b");
      save();
      await waitFor(() => expect(gate.out).toBe(true));
      // Another tab deletes the tool while this save is out.
      if (forgotten) forgetToolSample("1", sampleTicket());
      gate.release();
      await waitFor(() => expect(screen.queryAllByText("Save").length).toBe(0));
      answered[String(forgotten)] = kept("1") !== null;
      cleanup();
    }
    expect(answered).toEqual({ false: true, true: false });
  });

  // The captured definition is a REF: read after the request it would answer for whatever opening
  // followed a dismissed save, and judge this payload against another tool's sample.
  test("reads the captured definition before the request too", async () => {
    // Tool 2 has a sample of its own, so reopening on it puts a different capture on screen.
    rememberToolSample(
      "2",
      { revision: REV1, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    const gate = serveEditor();
    gate.hold = true;
    render(<EditorHarness />);
    await openTool("1");
    await runTest();
    edit("Lookup 1", "Lookup 1b");
    save();
    await waitFor(() => expect(gate.out).toBe(true));
    fireEvent.click(screen.getByText("close-it"));
    await openTool("2");
    gate.release();
    await act(async () => {});
    await waitFor(() => expect(kept("1")).not.toBeNull());
  });

  // Format changes whitespace and never a value, so the response still describes the definition it
  // was captured against: re-capturing it against the edited URL would keep a response of the old URL.
  test("formats the sample without capturing it again", async () => {
    const answered: Record<string, boolean> = {};
    for (const formatted of [false, true]) {
      serveEditor();
      render(<EditorHarness />);
      await openTool("1");
      // Pasted minified, so Format has something to do; captured against the URL on screen.
      writeSample(RESPONSE);
      edit("https://api.example.com/x", "https://api.example.com/novo");
      if (formatted) {
        const format = screen.getByRole("button", { name: "Format" });
        expect(format.hasAttribute("disabled")).toBe(false);
        fireEvent.click(format);
      }
      save();
      await waitFor(() => expect(screen.queryAllByText("Save").length).toBe(0));
      answered[String(formatted)] = kept("1") !== null;
      cleanup();
    }
    expect(answered).toEqual({ false: false, true: false });
  });

  // An opening that restores a kept sample records which definition it describes, through the same
  // rule an arrival uses: saved unchanged it is kept, saved with another URL it is not.
  test("records the sample's definition only through the rule that decides it", async () => {
    const answered: Record<string, boolean> = {};
    for (const urlChanged of [false, true]) {
      rememberToolSample(
        "1",
        { revision: REV1, text: RESPONSE, status: 200, credentialRef: null },
        sampleTicket(),
      );
      serveEditor();
      render(<EditorHarness />);
      await openTool("1");
      if (urlChanged) {
        edit("https://api.example.com/x", "https://api.example.com/novo");
      } else {
        edit("Lookup 1", "Lookup 1b");
      }
      save();
      await waitFor(() => expect(screen.queryAllByText("Save").length).toBe(0));
      answered[urlChanged ? "url changed" : "label changed"] =
        kept("1") !== null;
      cleanup();
    }
    expect(answered).toEqual({ "label changed": true, "url changed": false });
  });
});

// The Tools page's delete: the clearing lands in the tenant the delete was SENT under, even when
// another tab moves the tenant selector while the request is out.
describe("the Tools page's delete", () => {
  test("reads the ticket before the delete request too", async () => {
    localStorage.setItem("@app:active-tenant", "t-a");
    rememberToolSample(
      "1",
      { revision: REV1, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    let release = () => {};
    let out = false;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        out = true;
        await new Promise<void>((r) => (release = r));
        return json({ ok: true });
      }
      if (path === "/api/v1/tools") {
        return json({ tools: [tool("1", "https://api.example.com/x")] });
      }
      if (path === "/api/v1/code-tools") return json({ tools: [] });
      if (path.endsWith("/references"))
        return json({ references: { agents: [] } });
      return json({});
    }) as unknown as typeof fetch;
    render(
      <MemoryRouter>
        <ToastProvider>
          <TooltipPrimitive.Provider>
            <ToolsPanel />
          </TooltipPrimitive.Provider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Lookup 1");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(out).toBe(true));
    // Another tab moves the tenant selector while the delete is out.
    localStorage.setItem("@app:active-tenant", "t-b");
    release();
    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    localStorage.setItem("@app:active-tenant", "t-a");
    expect(kept("1", REV1)).toBeNull();
  });
});

// `updateUser` merges a late save into the user the context holds. A sign-out and that save landing
// in one batch must leave the operator signed out.
describe("the auth context", () => {
  test("keeps the merged-into user in step with the one setter", async () => {
    globalThis.fetch = (async () =>
      json({
        user: { id: "u1", email: "op@example.com", name: "Op", role: "ADMIN" },
      })) as unknown as typeof fetch;
    let auth = null as ReturnType<typeof useAuth> | null;
    function Probe() {
      auth = useAuth();
      return null;
    }
    render(
      <ThemeProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(auth?.user?.id).toBe("u1"));
    act(() => {
      window.dispatchEvent(new Event("auth:unauthorized"));
      auth?.updateUser("u1", { name: "Outro nome" });
    });
    expect(auth?.user ?? null).toBeNull();
  });
});
