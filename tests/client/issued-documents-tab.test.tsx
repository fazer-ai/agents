/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { IssuedDocumentsTab } from "@/client/pages/resources/documents/IssuedDocumentsTab";

// The issued tab is where somebody holding a printed number looks a document up: the search goes to
// the server (the rows on screen are one page), "Load more" walks the cursor, an answer to an older
// search never lands over a newer one, and each row leads to its conversation and its approval.

// Every assertion reduces to a boolean or a string BEFORE expect: a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/resources/documents",
);

type Doc = {
  id: string;
  title: string;
  number: string;
  templateId: string | null;
  status: string;
  threadId: string | null;
  conversationId: string | null;
  approvalRequestId: string | null;
  revoked: boolean;
  createdAt: string;
};

function doc(id: number, extra: Partial<Doc> = {}): Doc {
  return {
    id: String(id),
    title: "Orçamento",
    number: `ORC-${String(id).padStart(4, "0")}`,
    templateId: "3",
    status: "READY",
    threadId: null,
    conversationId: null,
    approvalRequestId: null,
    revoked: false,
    createdAt: "2026-10-01T12:00:00.000Z",
    ...extra,
  };
}

const realFetch = globalThis.fetch;
let requests: string[] = [];
// The `q` of each request the fake server has ANSWERED, in order.
let answered: string[] = [];
let answer: (q: URLSearchParams) => {
  documents: Doc[];
  nextBefore: string | null;
};
// A request held until the test releases it, keyed by `<q>|<before>`.
let held: Record<string, Promise<void>> = {};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push(`${method} ${url.pathname}${url.search}`);
  if (method !== "GET") return json({ success: true });
  const gate =
    held[
      `${url.searchParams.get("q") ?? ""}|${url.searchParams.get("before") ?? ""}`
    ];
  if (gate) await gate;
  answered.push(url.searchParams.get("q") ?? "");
  return json(answer(url.searchParams));
}) as unknown as typeof fetch;

beforeEach(() => {
  requests = [];
  answered = [];
  held = {};
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

function mount(
  templateNames: Map<string, string> | null = new Map([["3", "Orçamento"]]),
) {
  return render(
    <MemoryRouter initialEntries={["/resources/documents"]}>
      <ToastProvider>
        <IssuedDocumentsTab templateNames={templateNames} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const text = () => document.body.textContent ?? "";
const searchBox = () =>
  screen.getByRole("textbox", { name: /number or title/i }) as HTMLInputElement;

describe("issued documents tab", () => {
  test("a search asks the server and replaces the rows, and clearing it brings the first page back", async () => {
    answer = (q) =>
      q.get("q")
        ? { documents: [doc(2)], nextBefore: null }
        : { documents: [doc(30), doc(29)], nextBefore: "29" };
    mount();
    await waitFor(() => expect(text().includes("ORC-0030")).toBe(true));
    fireEvent.change(searchBox(), { target: { value: " ORC-0002 " } });
    await waitFor(() => expect(text().includes("ORC-0002")).toBe(true));
    expect(text().includes("ORC-0030")).toBe(false);
    expect(requests).toContain("GET /api/v1/documents?limit=20&q=ORC-0002");
    expect(text().includes("Load more")).toBe(false);
    fireEvent.change(searchBox(), { target: { value: "" } });
    await waitFor(() => expect(text().includes("ORC-0030")).toBe(true));
    expect(text().includes("ORC-0002")).toBe(false);
    expect(text().includes("Load more")).toBe(true);
  });

  test("an older search answering last does not take the screen", async () => {
    let release = () => {};
    held["ORC|"] = new Promise<void>((r) => {
      release = r;
    });
    answer = (q) =>
      q.get("q") === "ORC"
        ? { documents: [doc(9)], nextBefore: null }
        : q.get("q") === "ORC-0005"
          ? { documents: [doc(5)], nextBefore: null }
          : { documents: [doc(30)], nextBefore: null };
    mount();
    await waitFor(() => expect(text().includes("ORC-0030")).toBe(true));
    fireEvent.change(searchBox(), { target: { value: "ORC" } });
    await waitFor(() =>
      expect(requests.some((r) => r.endsWith("q=ORC"))).toBe(true),
    );
    fireEvent.change(searchBox(), { target: { value: "ORC-0005" } });
    await waitFor(() => expect(text().includes("ORC-0005")).toBe(true));
    release();
    await waitFor(() => expect(answered.at(-1)).toBe("ORC"));
    // The held answer has been served; a wrong render of it would land within the same retries.
    await expect(
      waitFor(() => expect(text().includes("ORC-0009")).toBe(true), {
        timeout: 300,
      }),
    ).rejects.toThrow();
    expect(text().includes("ORC-0005")).toBe(true);
  });

  test("Load more asks for the documents older than the last one and appends them", async () => {
    answer = (q) =>
      q.get("before") === "29"
        ? { documents: [doc(28), doc(27)], nextBefore: null }
        : { documents: [doc(30), doc(29)], nextBefore: "29" };
    mount();
    fireEvent.click(await screen.findByText("Load more"));
    await waitFor(() => expect(text().includes("ORC-0027")).toBe(true));
    expect(requests).toContain("GET /api/v1/documents?limit=20&before=29");
    const order = ["ORC-0030", "ORC-0029", "ORC-0028", "ORC-0027"].map((n) =>
      text().indexOf(n),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text().includes("Load more")).toBe(false);
  });

  test("a row links to its conversation and its approval, and only to what it has", async () => {
    answer = () => ({
      documents: [
        doc(5, { conversationId: "39", approvalRequestId: "40" }),
        doc(4, { conversationId: "12" }),
        doc(3),
      ],
      nextBefore: null,
    });
    mount();
    await waitFor(() => expect(text().includes("ORC-0003")).toBe(true));
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => `${a.textContent} ${a.getAttribute("href")}`);
    expect(hrefs).toEqual([
      "Conversation /conversations/39",
      "Approval /document-approvals/40",
      "Conversation /conversations/12",
    ]);
  });

  test("a revoke marks the row in place and keeps the pages already loaded", async () => {
    answer = (q) =>
      q.get("before") === "29"
        ? { documents: [doc(28)], nextBefore: null }
        : { documents: [doc(30), doc(29)], nextBefore: "29" };
    mount();
    fireEvent.click(await screen.findByText("Load more"));
    await waitFor(() => expect(text().includes("ORC-0028")).toBe(true));
    fireEvent.click(screen.getAllByText("Revoke")[2] as HTMLElement);
    const confirmButton = screen
      .getAllByRole("button")
      .filter((b) => b.textContent === "Revoke")
      .pop() as HTMLButtonElement;
    fireEvent.click(confirmButton);
    await waitFor(() => expect(text().includes("Revoked")).toBe(true));
    expect(requests).toContain("POST /api/v1/documents/28/revoke");
    expect(requests.filter((r) => r.startsWith("GET")).length).toBe(2);
    expect(text().includes("ORC-0028")).toBe(true);
  });

  test("a search that replaces the list while Load more is out leaves Load more usable", async () => {
    let release = () => {};
    held["|29"] = new Promise<void>((r) => {
      release = r;
    });
    answer = (q) =>
      q.get("q")
        ? { documents: [doc(2)], nextBefore: null }
        : q.get("before") === "29"
          ? { documents: [doc(28)], nextBefore: null }
          : { documents: [doc(30), doc(29)], nextBefore: "29" };
    mount();
    fireEvent.click(await screen.findByText("Load more"));
    await waitFor(() =>
      expect(requests.some((r) => r.endsWith("before=29"))).toBe(true),
    );
    fireEvent.change(searchBox(), { target: { value: "ORC-0002" } });
    await waitFor(() => expect(text().includes("ORC-0030")).toBe(false));
    fireEvent.change(searchBox(), { target: { value: "" } });
    await waitFor(() => expect(text().includes("ORC-0030")).toBe(true));
    const button = () =>
      screen
        .getAllByRole("button")
        .find((b) => b.textContent?.includes("Load more")) as HTMLButtonElement;
    await waitFor(() => expect(button().disabled).toBe(false));
    release();
    await waitFor(() => expect(answered.includes("")).toBe(true));
    expect(button().disabled).toBe(false);
  });

  test("a revoke survives a list that was read before it and answers after", async () => {
    let release = () => {};
    held["ORC|"] = new Promise<void>((r) => {
      release = r;
    });
    answer = () => ({ documents: [doc(30), doc(29)], nextBefore: null });
    mount();
    await waitFor(() => expect(text().includes("ORC-0030")).toBe(true));
    fireEvent.change(searchBox(), { target: { value: "ORC" } });
    await waitFor(() =>
      expect(requests.some((r) => r.endsWith("q=ORC"))).toBe(true),
    );
    fireEvent.click(screen.getAllByText("Revoke")[0] as HTMLElement);
    const confirmButton = screen
      .getAllByRole("button")
      .filter((b) => b.textContent === "Revoke")
      .pop() as HTMLButtonElement;
    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(requests).toContain("POST /api/v1/documents/30/revoke"),
    );
    await waitFor(() => expect(screen.getAllByText("Revoke").length).toBe(1));
    release();
    await waitFor(() => expect(answered.at(-1)).toBe("ORC"));
    await expect(
      waitFor(() => expect(screen.getAllByText("Revoke").length).toBe(2), {
        timeout: 300,
      }),
    ).rejects.toThrow();
  });

  test("a template name not read yet is not called deleted", async () => {
    answer = () => ({
      documents: [doc(5), doc(4, { templateId: null })],
      nextBefore: null,
    });
    mount(null);
    await waitFor(() => expect(text().includes("ORC-0004")).toBe(true));
    expect(text().includes("Template deleted")).toBe(false);
    cleanup();
    mount(new Map());
    await waitFor(() => expect(text().includes("ORC-0004")).toBe(true));
    expect(text().includes("Template deleted")).toBe(true);
  });
});
