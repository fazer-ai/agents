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
