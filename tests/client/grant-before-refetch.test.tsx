/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type EditorStub,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// A component created from the Tools tab is granted to the agent being edited. The grant is in place
// while the catalog refresh that follows is still out, and it is added to the grants as they stand
// when the save answers, not as they stood when the dialog was opened.

const realFetch = globalThis.fetch;
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  cleanup();
  globalThis.fetch = realFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// A response held until the test lets it go (or the test ends).
function held(): { promise: Promise<Response>; answer: (r: Response) => void } {
  let answer: (r: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  releases.push(() => answer(json({})));
  return { promise, answer };
}

const OLD_TOOL = { id: "t-old", label: "Consulta antiga", enabled: true };

const type = (el: Element, value: string) =>
  fireEvent.change(el, { target: { value } });

const KINDS = [
  {
    kind: "HTTP tool",
    newButton: 0,
    path: "/api/v1/tools",
    fill(dialog: HTMLElement) {
      type(within(dialog).getByPlaceholderText("Look up order"), "Pedido");
      type(
        within(dialog).getByPlaceholderText(
          "https://api.example.com/orders/{{orderId}}",
        ),
        "https://api.example.com/orders",
      );
    },
    answer: () =>
      json({
        tool: {
          id: "new-1",
          name: "pedido",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    grant: { source: "HTTP", toolDefinitionId: "new-1" },
  },
  {
    kind: "code tool",
    newButton: 1,
    path: "/api/v1/code-tools",
    fill(dialog: HTMLElement) {
      type(within(dialog).getByPlaceholderText("Look up CPF"), "Valida CPF");
      type(
        within(dialog).getByPlaceholderText(
          "e.g. Check whether a CPF is valid before quoting.",
        ),
        "Confere o CPF.",
      );
    },
    answer: () =>
      json({ tool: { id: "new-1", name: "valida_cpf" }, warnings: [] }),
    grant: { source: "CODE", codeToolDefinitionId: "new-1" },
  },
  {
    kind: "MCP server",
    newButton: 2,
    path: "/api/v1/mcp-connections",
    fill(dialog: HTMLElement) {
      const [name, url] = within(dialog).getAllByRole("textbox");
      type(name as HTMLElement, "Planilhas");
      type(url as HTMLElement, "https://mcp.example.com/sse");
    },
    answer: () => json({ connection: { id: "new-1", name: "Planilhas" } }),
    grant: {
      source: "MCP",
      mcpServerConnectionId: "new-1",
      enabledTools: [],
    },
  },
] as const;

type Kind = (typeof KINDS)[number];

async function createFromTab(stub: EditorStub, k: Kind): Promise<void> {
  await renderEditor(stub, "tools");
  fireEvent.click(
    screen.getAllByRole("button", { name: "New" })[k.newButton] as HTMLElement,
  );
  const dialog = await screen.findByRole("dialog");
  k.fill(dialog);
  const save = within(dialog).getByRole("button", { name: "Save" });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
}

const catalogReads = (stub: EditorStub) =>
  stub.requests.filter((r) => r === "GET /api/v1/agents/41/tool-selections")
    .length;

async function savedGrants(stub: EditorStub): Promise<unknown[]> {
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Save tools" }));
  const put = await waitFor(() => {
    const w = stub.writes.find(
      (x) => x.method === "PUT" && x.path.endsWith("/tool-selections"),
    );
    if (!w) throw new Error("no PUT yet");
    return w;
  });
  return put.body.grants as unknown[];
}

describe("a component created from the Tools tab", () => {
  for (const k of KINDS) {
    test(`a new ${k.kind} is granted while the catalog refresh is still out`, async () => {
      const stub = stubEditorApi(
        {},
        { catalog: { toolDefinitions: [OLD_TOOL] } },
      );
      let reads = 0;
      stub.override = (method, path) => {
        if (method === "POST" && path === k.path) return k.answer();
        if (method === "GET" && path.endsWith("/tool-selections")) {
          reads += 1;
          if (reads > 1) return held().promise;
        }
        return undefined;
      };
      await createFromTab(stub, k);
      await waitFor(() => expect(catalogReads(stub)).toBeGreaterThan(1));

      expect(await savedGrants(stub)).toContainEqual(k.grant);
    });

    test(`a grant changed while the new ${k.kind} was saving is kept`, async () => {
      const stub = stubEditorApi(
        {},
        { catalog: { toolDefinitions: [OLD_TOOL] } },
      );
      const creation = held();
      stub.override = (method, path) =>
        method === "POST" && path === k.path ? creation.promise : undefined;
      await createFromTab(stub, k);
      await waitFor(() => expect(stub.requests).toContain(`POST ${k.path}`));
      // NOTE: behind the open dialog, which hides the page from the accessibility tree.
      fireEvent.click(
        screen.getByRole("checkbox", { name: /Consulta antiga/, hidden: true }),
      );
      await act(async () => creation.answer(k.answer()));
      await waitFor(() =>
        expect(screen.queryByRole("dialog") === null).toBe(true),
      );

      const grants = await savedGrants(stub);
      expect(grants).toContainEqual(k.grant);
      expect(grants).toContainEqual({
        source: "HTTP",
        toolDefinitionId: "t-old",
      });
    });
  }
});
