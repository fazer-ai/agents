/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import i18next from "i18next";
import {
  UsageFigure,
  usageDetail,
  usageFigureText,
} from "@/client/components/TokenUsage";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import {
  addUsage,
  agentTurn,
  NO_USAGE,
  type PlaygroundUsage,
} from "@/client/pages/agents/usePlaygroundChat";

// Issues #839 and #858: what a playground turn spent, in the words the operator reads. One figure is
// always on screen, the input tokens; the rest is in the popover. The rule the detail carries is the
// one from #706: the cached share is always said, as a PART of the input (never subtracted from it,
// never left out), and a cache write only when there was one.

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
  return i.t.bind(i) as unknown as Parameters<typeof usageDetail>[0];
}

const TURN: PlaygroundUsage = {
  calls: 2,
  promptTokens: 1500,
  cachedReadTokens: 1024,
  cacheCreationTokens: 0,
  completionTokens: 100,
  byNode: { agent: 1, guardrail: 1 },
  costUsd: 0,
  unpricedCalls: 2,
  olderTablePricedCalls: 0,
  tenantPricedCalls: 0,
};

describe("the figure on screen", () => {
  test("is the input tokens, compact", async () => {
    expect(usageFigureText(await tIn("en"), "en", TURN)).toBe(
      "1.5K input tokens",
    );
    // The compact form's space is ICU's no-break space; the words are ours.
    expect(
      usageFigureText(await tIn("pt-BR"), "pt-BR", {
        ...TURN,
        promptTokens: 12345,
      }).replace(/\u00a0/g, " "),
    ).toBe("12,3 mil tokens de entrada");
  });
});

describe("the detail", () => {
  test("the input carries its cached share, then the output and the calls by step", async () => {
    const en = usageDetail(await tIn("en"), "en", TURN);
    expect(en).toMatchObject({
      input: "1,500",
      cached: "1,024",
      cachedPct: 68,
      cacheWrite: null,
      output: "100",
      calls: 2,
    });
    expect(en.steps.map((s) => [s.label, s.calls])).toEqual([
      ["agent", 1],
      ["guardrail check", 1],
    ]);
    const pt = usageDetail(await tIn("pt-BR"), "pt-BR", TURN);
    expect([pt.input, pt.cached, pt.output]).toEqual(["1.500", "1.024", "100"]);
    expect(pt.steps.map((s) => s.label)).toEqual([
      "agente",
      "verificação de guardrails",
    ]);
  });

  test("a turn with nothing from cache still says so, as a zero share", async () => {
    const d = usageDetail(await tIn("en"), "en", {
      ...TURN,
      cachedReadTokens: 0,
    });
    expect([d.cached, d.cachedPct]).toEqual(["0", 0]);
  });

  test("a cache write shows only when there was one", async () => {
    expect(
      usageDetail(await tIn("pt-BR"), "pt-BR", {
        ...TURN,
        cacheCreationTokens: 256,
      }).cacheWrite,
    ).toBe("256");
    expect(usageDetail(await tIn("en"), "en", TURN).cacheWrite).toBeNull();
  });

  test("a step the words do not know is shown by its name", async () => {
    expect(
      usageDetail(await tIn("en"), "en", {
        ...TURN,
        calls: 1,
        byNode: { brand_new_step: 1 },
      }).steps.map((s) => s.label),
    ).toEqual(["brand_new_step"]);
  });

  test("the busiest step comes first", async () => {
    expect(
      usageDetail(await tIn("en"), "en", {
        ...TURN,
        calls: 4,
        byNode: { agent: 1, guardrail: 3 },
      }).steps.map((s) => s.node),
    ).toEqual(["guardrail", "agent"]);
  });
});

describe("the detail with timing", () => {
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

  test("a timed turn says how long it took and how much of it was the model", async () => {
    const timing = { turnMs: 3420, modelMs: 2910 };
    expect(usageDetail(await tIn("en"), "en", TURN, timing)).toMatchObject({
      turn: sec("en", 3.4),
      model: sec("en", 2.9),
      modelPct: 85,
    });
    const pt = usageDetail(await tIn("pt-BR"), "pt-BR", TURN, timing);
    expect([pt.turn, pt.model]).toEqual([sec("pt-BR", 3.4), sec("pt-BR", 2.9)]);
    expect(sec("pt-BR", 3.4)).toStartWith("3,4");
  });

  test("an unknown time is left out, never shown as zero", async () => {
    expect(
      usageDetail(await tIn("en"), "en", TURN, { turnMs: null, modelMs: null }),
    ).toMatchObject({ turn: null, model: null, modelPct: null });
    expect(
      usageDetail(await tIn("en"), "en", TURN, { turnMs: 2000, modelMs: null }),
    ).toMatchObject({ turn: sec("en", 2), model: null, modelPct: null });
  });

  test("the model's share never passes the whole", async () => {
    // Calls the turn awaited in parallel can sum past its wall time.
    expect(
      usageDetail(await tIn("en"), "en", TURN, { turnMs: 1000, modelMs: 1500 })
        .modelPct,
    ).toBe(100);
  });
});

describe("UsageFigure", () => {
  test("a turn that made no model call draws nothing", () => {
    render(<UsageFigure usage={NO_USAGE} />);
    expect(screen.queryByTestId("token-usage")).toBeNull();
    render(<UsageFigure usage={undefined} />);
    expect(screen.queryByTestId("token-usage")).toBeNull();
  });

  test("the session total names itself", () => {
    render(<UsageFigure usage={TURN} label="Session" />);
    expect(screen.getByTestId("token-usage").textContent).toStartWith(
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
      byNode: { agent: 2, guardrail: 2 },
      costUsd: 0,
      unpricedCalls: 4,
      olderTablePricedCalls: 0,
      tenantPricedCalls: 0,
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
  const READ_TURN = "0b6f1c3e-5a4e-4d7a-9c1e-2f3a4b5c6d7e";

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
    const fileTurnIds: (string | null)[] = [];
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
          turnId: READ_TURN,
          usage: READ,
          timing: { turnMs: 5, modelMs: 4 },
        });
      }
      if (url.includes("/playground/file")) {
        turnPosts.push(url);
        const body = req
          ? await req.formData()
          : (init?.body as FormData | undefined);
        fileTurnIds.push((body?.get("turnId") as string | null) ?? null);
        return turn();
      }
      if (url.includes("/playground/sessions/"))
        return json({
          threadId: THREAD,
          usage: ledger.get(THREAD) ?? NO_USAGE,
          turns: [
            { role: "user", text: "oi", turnId: "t1", trace: [], sources: [] },
            {
              role: "assistant",
              text: "ok",
              turnId: "t1",
              usage: REPLY,
              trace: [],
              sources: [],
            },
          ],
        });
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
    return { sessionLists, turnPosts, fileTurnIds };
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

  test("the file turn hands the read's id back, so the ledger keeps them as one turn", async () => {
    const { act } = await import("@testing-library/react");
    const srv = server({ failTurns: 0 });
    const { result } = await mount();
    await act(async () => {
      await result.current.sendFile(
        new File(["x"], "nota.png", { type: "image/png" }),
      );
    });
    expect(srv.fileTurnIds).toEqual([READ_TURN]);
  });

  test("a reopened session shows each reply's line from the server", async () => {
    const { act } = await import("@testing-library/react");
    server({ failTurns: 0 });
    const { result } = await mount();
    await act(async () => {
      await result.current.loadSession(THREAD);
    });
    const reply = result.current.turns.at(-1);
    expect(reply?.role === "assistant" && reply.usage).toEqual(REPLY);
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
