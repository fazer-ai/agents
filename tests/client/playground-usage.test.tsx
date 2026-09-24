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
  // The unit's spacing is ICU locale data, not ours: macOS writes "3,4s" in pt-BR and the CI's
  // Linux writes "3,4 s". The numbers and the rounding are ours, so those are fixed here.
  const sec = (locale: string, v: number) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(v);

  test("a live turn says how long it took and how much was model time", async () => {
    const timing = { turnMs: 3420, modelMs: 2910 };
    expect(usageText(await tIn("en"), "en", TURN, timing)).toBe(
      `In 1,500 (1,024 from cache) · out 100 · 2 calls · ${sec("en", 3.4)} (model ${sec("en", 2.9)})`,
    );
    expect(usageText(await tIn("pt-BR"), "pt-BR", TURN, timing)).toBe(
      `Entrada 1.500 (1.024 do cache) · saída 100 · 2 chamadas · ${sec("pt-BR", 3.4)} (modelo ${sec("pt-BR", 2.9)})`,
    );
    expect(sec("pt-BR", 3.4)).toStartWith("3,4");
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

// The hook's own books (issue #839, review rounds 1 to 3). The session total is the LEDGER's, re-read
// after every turn: a turn can fail after a call it was billed for, and only the ledger has that
// call. A new session gets its thread before its first call, so such a call lands on the thread the
// session keeps. The fake server below keeps a ledger per thread, the way the real one does.
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
  // A turn screened before the agent failed: the ledger has that call, the reply has nothing.
  const SCREEN: PlaygroundUsage = {
    ...NO_USAGE,
    calls: 1,
    promptTokens: 200,
    completionTokens: 10,
  };
  const THREAD = "1:playground:7:abc";

  function server(opts: {
    failTurns: number;
    failThreads?: boolean;
    // The read is billed and then its answer is lost.
    failExtract?: boolean;
  }) {
    const ledger = new Map<string, PlaygroundUsage>();
    const bill = (tid: string, u: PlaygroundUsage) =>
      ledger.set(tid, addUsage(ledger.get(tid) ?? NO_USAGE, u));
    let failuresLeft = opts.failTurns;
    const sessionLists: number[] = [];
    const turnPosts: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const req = input instanceof Request ? input : null;
      const url = String(req ? req.url : input);
      const method = (req ? req.method : init?.method) ?? "GET";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      const reply = () =>
        json({
          reply: "ok",
          threadId: THREAD,
          trace: [],
          sources: [],
          suppressed: false,
          usage: REPLY,
          timing: { turnMs: 10, modelMs: 8 },
        });
      const turn = () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          bill(THREAD, SCREEN);
          return json({ error: "boom" }, 500);
        }
        bill(THREAD, REPLY);
        return reply();
      };
      if (url.endsWith("/playground/threads"))
        return opts.failThreads
          ? json({ error: "down" }, 500)
          : json({ threadId: THREAD });
      if (url.endsWith("/usage"))
        return json({ usage: ledger.get(THREAD) ?? NO_USAGE });
      if (url.includes("/playground/file/extract")) {
        bill(THREAD, READ);
        if (opts.failExtract) return json({ error: "lost" }, 500);
        return json({
          kind: "image",
          extracted: "nota",
          threadId: THREAD,
          usage: READ,
          timing: { turnMs: 5, modelMs: 4 },
        });
      }
      if (url.includes("/playground/file")) {
        turnPosts.push(url);
        return turn();
      }
      if (url.endsWith("/playground") && method === "POST") {
        turnPosts.push(url);
        return turn();
      }
      if (url.endsWith("/playground/sessions")) {
        sessionLists.push(Date.now());
        return json({ sessions: [] });
      }
      if (url.includes("/playground/tools")) return json({ tools: [] });
      return json({});
    }) as typeof fetch;
    return { sessionLists, turnPosts };
  }

  async function mount() {
    const { renderHook } = await import("@testing-library/react");
    const { usePlaygroundChat } = await import(
      "@/client/pages/agents/usePlaygroundChat"
    );
    return renderHook(() => usePlaygroundChat("7", false));
  }

  async function sendText(
    result: {
      current: ReturnType<
        typeof import("@/client/pages/agents/usePlaygroundChat").usePlaygroundChat
      >;
    },
    text: string,
  ) {
    const { act } = await import("@testing-library/react");
    await act(async () => {
      result.current.setInput(text);
    });
    await act(async () => {
      await result.current.send();
    });
  }

  test("a file turn shows its read and its reply on one line, and the total is the ledger's", async () => {
    const { act } = await import("@testing-library/react");
    server({ failTurns: 0 });
    const { result } = await mount();
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

  test("a first turn that fails after a billed call still shows that call in the total", async () => {
    server({ failTurns: 1 });
    const { result } = await mount();
    await sendText(result, "oi");
    // The session's thread existed before the call, so the screening billed on it is in the total.
    expect(result.current.sessionUsage).toEqual(SCREEN);
    await sendText(result, "de novo");
    expect(result.current.sessionUsage).toEqual(addUsage(SCREEN, REPLY));
  });

  test("a read whose turn failed is counted, and the retry's success lists the session", async () => {
    const { act } = await import("@testing-library/react");
    const srv = server({ failTurns: 1 });
    const { result } = await mount();
    await act(async () => {
      await result.current.sendFile(
        new File(["x"], "nota.png", { type: "image/png" }),
      );
    });
    expect(result.current.sessionUsage).toEqual(addUsage(READ, SCREEN));
    const listedBefore = srv.sessionLists.length;
    await sendText(result, "oi");
    expect(result.current.sessionUsage).toEqual(
      addUsage(addUsage(READ, SCREEN), REPLY),
    );
    // The thread existed since the read, but its session row only now: the history is refreshed.
    expect(srv.sessionLists.length).toBeGreaterThan(listedBefore);
  });

  test("with no thread for the session, no billed call is made", async () => {
    const srv = server({ failTurns: 0, failThreads: true });
    const { result } = await mount();
    await sendText(result, "oi");
    expect(srv.turnPosts).toEqual([]);
    expect(result.current.turns.at(-1)?.role).toBe("error");
  });

  test("a read billed and then lost is still in the total", async () => {
    const { act } = await import("@testing-library/react");
    server({ failTurns: 0, failExtract: true });
    const { result } = await mount();
    await act(async () => {
      await result.current.sendFile(
        new File(["x"], "nota.png", { type: "image/png" }),
      );
    });
    expect(result.current.sessionUsage).toEqual(READ);
  });
});
