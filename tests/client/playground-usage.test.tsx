/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import i18next from "i18next";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import { UsageLine, usageText } from "@/client/pages/agents/PlaygroundUsage";
import {
  addUsage,
  agentTurn,
  NO_USAGE,
  type PlaygroundUsage,
} from "@/client/pages/agents/usePlaygroundChat";

// Issue #839: what a playground turn spent, in the words the operator reads. The rule the line
// carries is the one from #706: the cached share is always said, as a PART of the input (never
// subtracted from it, never left out), and a cache write only when there was one.

afterEach(cleanup);

async function tIn(lng: "en" | "pt-BR") {
  const i = i18next.createInstance();
  await i.init({
    lng,
    resources: {
      en: { translation: clientEn },
      "pt-BR": { translation: clientPt },
    },
    interpolation: { escapeValue: false },
  });
  return i.t.bind(i) as unknown as Parameters<typeof usageText>[0];
}

const TURN: PlaygroundUsage = {
  calls: 2,
  promptTokens: 1500,
  cachedReadTokens: 1024,
  cacheCreationTokens: 0,
  completionTokens: 100,
};

describe("usageText", () => {
  test("the input carries its cached share, the output and the calls follow", async () => {
    expect(usageText(await tIn("en"), "en", TURN)).toBe(
      "In 1,500 (1,024 from cache) · out 100 · 2 calls",
    );
    expect(usageText(await tIn("pt-BR"), "pt-BR", TURN)).toBe(
      "Entrada 1.500 (1.024 do cache) · saída 100 · 2 chamadas",
    );
  });

  test("a turn with nothing from cache still says so, rather than showing the input alone", async () => {
    expect(
      usageText(await tIn("en"), "en", { ...TURN, cachedReadTokens: 0 }),
    ).toBe("In 1,500 (0 from cache) · out 100 · 2 calls");
  });

  test("a cache write shows only when there was one", async () => {
    expect(
      usageText(await tIn("pt-BR"), "pt-BR", {
        ...TURN,
        calls: 1,
        cacheCreationTokens: 256,
      }),
    ).toBe(
      "Entrada 1.500 (1.024 do cache) · escrita no cache 256 · saída 100 · 1 chamada",
    );
  });
});

describe("UsageLine", () => {
  test("a turn that made no model call draws nothing", () => {
    render(<UsageLine usage={NO_USAGE} />);
    expect(screen.queryByTestId("playground-usage")).toBeNull();
    render(<UsageLine usage={undefined} />);
    expect(screen.queryByTestId("playground-usage")).toBeNull();
  });

  test("the session total names itself", () => {
    render(<UsageLine usage={TURN} label="Session" />);
    expect(screen.getByTestId("playground-usage").textContent).toStartWith(
      "Session: ",
    );
  });
});

describe("the turn keeps its usage", () => {
  const t = (_key: string, fallback: string) => fallback;
  const base = { text: "oi", trace: [], sources: [], usage: TURN } as never;

  test("on a reply, and on the notes a spent turn can turn into", () => {
    const reply = agentTurn(t, base);
    expect(reply.role === "assistant" && reply.usage).toEqual(TURN);
    const suppressed = agentTurn(t, {
      ...(base as object),
      text: "",
      suppressed: true,
    } as never);
    expect(suppressed.role === "note" && suppressed.usage).toEqual(TURN);
    const silent = agentTurn(t, {
      ...(base as object),
      text: "",
      silent: true,
      followup: true,
    } as never);
    expect(silent.role === "note" && silent.usage).toEqual(TURN);
  });

  test("the session total is the turns summed", () => {
    expect(addUsage(addUsage(NO_USAGE, TURN), TURN)).toEqual({
      calls: 4,
      promptTokens: 3000,
      cachedReadTokens: 2048,
      cacheCreationTokens: 0,
      completionTokens: 200,
    });
  });
});

// The hook's own books (issue #839, review round 1): a file's read is billed the moment it lands,
// whether or not the turn after it succeeds, and a thread the read named is not yet a saved session.
describe("usePlaygroundChat keeps the session total and the history honest", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const READ: PlaygroundUsage = {
    ...NO_USAGE,
    calls: 1,
    promptTokens: 400,
    completionTokens: 30,
  };
  const REPLY: PlaygroundUsage = {
    ...NO_USAGE,
    calls: 1,
    promptTokens: 900,
    completionTokens: 50,
  };
  const THREAD = "1:playground:7:abc";

  function stub(opts: { failFileTurn: boolean }) {
    const calls: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input instanceof Request ? input.url : input);
      const method =
        (input instanceof Request ? input.method : init?.method) ?? "GET";
      calls.push(`${method} ${new URL(url, "http://x").pathname}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/playground/file/extract"))
        return json({
          kind: "image",
          extracted: "nota",
          threadId: THREAD,
          usage: READ,
        });
      if (url.includes("/playground/file"))
        return opts.failFileTurn
          ? json({ error: "boom" }, 500)
          : json({
              reply: "ok",
              threadId: THREAD,
              trace: [],
              sources: [],
              suppressed: false,
              usage: REPLY,
            });
      if (url.endsWith("/playground") && method === "POST")
        return json({
          reply: "ok",
          threadId: THREAD,
          trace: [],
          sources: [],
          suppressed: false,
          usage: REPLY,
        });
      if (url.includes("/playground/sessions")) return json({ sessions: [] });
      if (url.includes("/playground/tools")) return json({ tools: [] });
      return json({});
    }) as typeof fetch;
    return calls;
  }

  test("a read whose turn failed is still counted, and the next turn's success lists the session", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { usePlaygroundChat } = await import(
      "@/client/pages/agents/usePlaygroundChat"
    );
    stub({ failFileTurn: true });
    const { result } = renderHook(() => usePlaygroundChat("7", false));
    await act(async () => {
      await result.current.sendFile(
        new File(["x"], "nota.png", { type: "image/png" }),
      );
    });
    // The read was billed and the turn never happened: the total says the read.
    expect(result.current.sessionUsage).toEqual(READ);

    const after = stub({ failFileTurn: false });
    await act(async () => {
      result.current.setInput("oi");
    });
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.sessionUsage).toEqual(addUsage(READ, REPLY));
    // The thread existed since the read, but its session row only now: the history is refreshed.
    expect(
      after.filter((c) => c === "GET /api/v1/agents/7/playground/sessions")
        .length,
    ).toBeGreaterThan(0);
  });
});
