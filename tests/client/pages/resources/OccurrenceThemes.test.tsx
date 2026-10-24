/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { OccurrenceThemes } from "@/client/pages/resources/OccurrenceThemes";

// The open themes card: an expanded theme shows its own conversations, whatever order the answers
// arrive in, and a detail that cannot be read says so and can be asked again.

const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const theme = (id: string, title: string) => ({
  id,
  title,
  reference: null,
  conversations: 1,
  firstSeenAt: "2026-10-19T12:00:00.000Z",
  lastSeenAt: "2026-10-19T12:00:00.000Z",
  flags: [],
});

const detail = (id: string, sentence: string) => ({
  theme: {
    ...theme(id, id),
    conversationsShown: [
      {
        conversationId: id,
        chatwootConversationId: Number(id) * 10,
        url: `https://cw.example.com/${id}`,
        sentence,
        reference: null,
      },
    ],
    events: [] as unknown[],
  },
});

// Each detail request waits for its own release, so a test decides the order answers land in.
function installFetchStub(
  details: (id: string, attempt: number) => Promise<Response>,
  list: () => { themes: unknown[]; total: number } = () => ({
    themes: [theme("1", "Pix"), theme("2", "Boleto")],
    total: 2,
  }),
) {
  const attempts = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/api/v1/occurrences/monitors/7/themes")
      return json(list());
    const id = /^\/api\/v1\/occurrences\/monitors\/7\/themes\/(\d+)$/.exec(
      url.pathname,
    )?.[1];
    if (id) {
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      return details(id, n);
    }
    return json({}, 404);
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("OccurrenceThemes", () => {
  test("Refresh reads the expanded theme's conversations again with the list", async () => {
    installFetchStub(async (id, attempt) =>
      json(detail(id, attempt === 1 ? "pix antigo" : "pix depois da rodada")),
    );
    render(<OccurrenceThemes monitorId="7" />);
    fireEvent.click(await screen.findByText("Pix"));
    await screen.findByText(/pix antigo/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/pix depois da rodada/);
    expect(screen.queryByText(/pix antigo/)).toBeNull();
  });

  test("a slow answer for a theme opened before never shows under the one opened after", async () => {
    let releaseFirst: () => void = () => {};
    installFetchStub((id) =>
      id === "1"
        ? new Promise((resolve) => {
            releaseFirst = () => resolve(json(detail("1", "pix nao caiu")));
          })
        : Promise.resolve(json(detail("2", "boleto nao gerou"))),
    );
    render(<OccurrenceThemes monitorId="7" />);
    fireEvent.click(await screen.findByText("Pix"));
    fireEvent.click(screen.getByText("Boleto"));
    await screen.findByText("boleto nao gerou");
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("pix nao caiu")).toBeNull();
    expect(screen.getByText("boleto nao gerou")).toBeTruthy();
  });

  test("a detail that cannot be read says so, and trying again shows it", async () => {
    installFetchStub((id, attempt) =>
      Promise.resolve(
        attempt === 1 ? json({}, 500) : json(detail(id, "pix nao caiu")),
      ),
    );
    render(<OccurrenceThemes monitorId="7" />);
    fireEvent.click(await screen.findByText("Pix"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not read");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("pix nao caiu")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a count reads in the singular and the plural", async () => {
    installFetchStub(
      async (id) => json(detail(id, "x")),
      () => ({
        themes: [
          { ...theme("1", "Pix"), conversations: 1 },
          { ...theme("2", "Boleto"), conversations: 2 },
        ],
        total: 2,
      }),
    );
    render(<OccurrenceThemes monitorId="7" />);
    expect(await screen.findByText("1 conversation")).toBeTruthy();
    expect(screen.getByText("2 conversations")).toBeTruthy();
  });

  test("the themes are paged from one read: a later reorder never repeats or skips one, and the total is said", async () => {
    let reads = 0;
    const all = (order: number[]) =>
      order.map((n) => theme(String(n), `Tema ${n}`));
    installFetchStub(
      async (id) => json(detail(id, "x")),
      () => {
        reads += 1;
        // A round between pages would put the last theme first: the screen keeps its first read.
        const order = Array.from({ length: 45 }, (_, i) => i + 1);
        return {
          themes: all(reads === 1 ? order : [45, ...order.slice(0, 44)]),
          total: 45,
        };
      },
    );
    render(<OccurrenceThemes monitorId="7" />);
    expect(await screen.findByText("1 to 20 of 45")).toBeTruthy();
    const seen: string[] = [];
    const titles = () =>
      screen.getAllByText(/^Tema \d+$/).map((e) => e.textContent ?? "");
    seen.push(...titles());
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("21 to 40 of 45")).toBeTruthy();
    seen.push(...titles());
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("41 to 45 of 45")).toBeTruthy();
    seen.push(...titles());
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    expect(reads).toBe(1);
    expect(
      (screen.getByRole("button", { name: /Next/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("past what one read returns, the screen says how many there are in all", async () => {
    installFetchStub(
      async (id) => json(detail(id, "x")),
      () => ({ themes: [theme("1", "Pix")], total: 640 }),
    );
    render(<OccurrenceThemes monitorId="7" />);
    expect(
      await screen.findByText("Showing the first 1 of 640 open themes."),
    ).toBeTruthy();
  });

  test("opening the tab again reads the expanded theme's conversations again", async () => {
    installFetchStub(async (id, attempt) =>
      json(detail(id, attempt === 1 ? "antes" : "depois da rodada")),
    );
    const view = render(<OccurrenceThemes monitorId="7" active />);
    fireEvent.click(await screen.findByText("Pix"));
    await screen.findByText("antes");
    view.rerender(<OccurrenceThemes monitorId="7" active={false} />);
    view.rerender(<OccurrenceThemes monitorId="7" active />);
    expect(await screen.findByText("depois da rodada")).toBeTruthy();
  });

  test("a theme names its reference only when it says more than the title, and says when it was last seen", async () => {
    const minutesAgo = (m: number) =>
      new Date(Date.now() - m * 60_000).toISOString();
    installFetchStub(
      async () => json({}, 404),
      () => ({
        themes: [
          {
            ...theme("1", "Pagamento com cartão"),
            reference: "pagamento com cartao",
            conversations: 2,
            firstSeenAt: minutesAgo(12),
            lastSeenAt: minutesAgo(12),
          },
          {
            ...theme("2", "Cobrança duplicada"),
            reference: "Loja Centro",
            firstSeenAt: minutesAgo(90),
            lastSeenAt: minutesAgo(30),
          },
        ],
        total: 2,
      }),
    );
    render(<OccurrenceThemes monitorId="7" />);
    await screen.findByText("Pagamento com cartão");
    // The same words as the title are not repeated; a different reference is labelled.
    expect(screen.queryByText(/pagamento com cartao/)).toBeNull();
    expect(screen.getByText("Reference: Loja Centro")).toBeTruthy();
    // One relative time on the row, no native tooltip; the exact times are in the opened theme,
    // once when they are the same.
    const seen = screen.getByText("last seen 12 minutes ago");
    expect(seen.tagName).toBe("TIME");
    expect(seen.hasAttribute("title")).toBe(false);
    expect(screen.getByText("last seen 30 minutes ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Pagamento com cart/ }));
    expect(await screen.findByText(/^Seen at /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Pagamento com cart/ }));
    fireEvent.click(screen.getByRole("button", { name: /Cobrança duplicada/ }));
    expect(await screen.findByText(/^Seen from .+ to .+\.$/)).toBeTruthy();
  });

  test("an opened theme's history says each decision, with the model's reason under it when there is one", async () => {
    installFetchStub(async (id) =>
      json({
        theme: {
          ...detail(id, "pix nao caiu").theme,
          events: [
            {
              kind: "rename",
              themeId: id,
              themeTitle: "Pix",
              intoId: null,
              at: "2026-10-19T13:00:00.000Z",
              detail: { from: "Duvida", to: "Pix", reason: "R-RENAME" },
            },
            {
              kind: "merge",
              themeId: "9",
              themeTitle: "Pix nao entrou",
              intoId: id,
              at: "2026-10-19T12:30:00.000Z",
              detail: null,
            },
            {
              kind: "split",
              themeId: "7",
              themeTitle: "Pagamento",
              intoId: null,
              at: "2026-10-19T12:00:00.000Z",
              detail: {
                into: [id, "8"],
                titles: ["Pix", "Boleto"],
                reason: "R-SPLIT",
              },
            },
          ],
        },
      }),
    );
    render(<OccurrenceThemes monitorId="7" />);
    fireEvent.click(await screen.findByText("Pix"));
    await screen.findByText("History");
    const items = screen
      .getAllByRole("listitem")
      .filter((li) => li.querySelector("time") && li.closest("div.mt-2"));
    const texts = items.map((li) => li.textContent ?? "");
    expect(texts[0]).toContain("Renamed from “Duvida” to “Pix”");
    expect(texts[0]).toContain("R-RENAME");
    // A merge with no reason shows the decision alone: no empty line under it.
    expect(texts[1]).toContain("“Pix nao entrou” joined into this theme");
    expect(items[1]?.querySelectorAll("span").length).toBe(1);
    expect(texts[2]).toContain("“Pagamento” split into “Pix”, “Boleto”");
    expect(texts[2]).toContain("R-SPLIT");
  });

  test("a theme with no history shows no history section", async () => {
    installFetchStub(async (id) => json(detail(id, "pix nao caiu")));
    render(<OccurrenceThemes monitorId="7" />);
    fireEvent.click(await screen.findByText("Pix"));
    await screen.findByText("pix nao caiu");
    expect(screen.queryByText("History")).toBeNull();
  });
});
