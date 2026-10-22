/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { TraceRow } from "@/client/pages/agents/PlaygroundChat";
import { createTestI18n, withI18n } from "@/tests/utils/i18n";

const catalogs = { en: { translation: en }, "pt-BR": { translation: ptBR } };

describe("an observed trip in the playground trace", () => {
  afterEach(() => cleanup());

  // The bug it catches: the row saying the check tripped while hiding why, which is the one thing an
  // operator tuning a policy in the playground came to read.
  test("shows the categories and the rationale", () => {
    const { container } = render(
      withI18n(
        <TraceRow
          entry={{
            type: "guardrail",
            direction: "input",
            outcome: "observed",
            action: "observe",
            categories: ["unsafe_content"],
            rationale: "RAZAO-OBS-1",
          }}
        />,
        createTestI18n("en", catalogs),
      ),
    );
    const text = container.textContent ?? "";
    expect(text.includes("unsafe_content — RAZAO-OBS-1")).toBe(true);
    expect(text.includes("only recorded")).toBe(true);
  });
});
