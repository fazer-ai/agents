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

describe("usageText with timing", () => {
  test("a live turn says how long it took and how much was model time", async () => {
    const timing = { turnMs: 3420, modelMs: 2910 };
    expect(usageText(await tIn("en"), "en", TURN, timing)).toBe(
      "In 1,500 (1,024 from cache) · out 100 · 2 calls · 3.4s (model 2.9s)",
    );
    expect(usageText(await tIn("pt-BR"), "pt-BR", TURN, timing)).toBe(
      "Entrada 1.500 (1.024 do cache) · saída 100 · 2 chamadas · 3,4s (modelo 2,9s)",
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
  // The failed turn was screened before the agent failed: the ledger has that call, the reply nothing.
  const SCREEN: PlaygroundUsage = {
    ...NO_USAGE,
    calls: 1,
    promptTokens: 200,
    completionTokens: 10,
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
      if (url.endsWith("/usage"))
        return json({
          usage: addUsage(READ, opts.failFileTurn ? SCREEN : NO_USAGE),
        });
      if (url.includes("/playground/sessions")) return json({ sessions: [] });
      if (url.includes("/playground/tools")) return json({ tools: [] });
      return json({});
    }) as typeof fetch;
    return calls;
  }

  test("a file turn counts its read and its reply, once each", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { usePlaygroundChat } = await import(
      "@/client/pages/agents/usePlaygroundChat"
    );
    stub({ failFileTurn: false });
    const { result } = renderHook(() => usePlaygroundChat("7", false));
    await act(async () => {
      await result.current.sendFile(
        new File(["x"], "nota.png", { type: "image/png" }),
      );
    });
    expect(result.current.sessionUsage).toEqual(addUsage(READ, REPLY));
    const turn = result.current.turns.at(-1);
    expect(turn?.role === "assistant" && turn.usage).toEqual(
      addUsage(READ, REPLY),
    );
  });

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
    // The read was billed, and so was the screening of the turn that then failed: the reply carried
    // neither, so the total is the ledger's, re-read after the failure.
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() =>
      expect(result.current.sessionUsage).toEqual(addUsage(READ, SCREEN)),
    );

    const after = stub({ failFileTurn: false });
    await act(async () => {
      result.current.setInput("oi");
    });
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.sessionUsage).toEqual(
      addUsage(addUsage(READ, SCREEN), REPLY),
    );
    // The thread existed since the read, but its session row only now: the history is refreshed.
    expect(
      after.filter((c) => c === "GET /api/v1/agents/7/playground/sessions")
        .length,
    ).toBeGreaterThan(0);
  });
});
