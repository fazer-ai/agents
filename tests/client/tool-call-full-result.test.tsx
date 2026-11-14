/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ToolCallDetails } from "@/client/components/ToolCallDetails";
import clientEn from "@/client/locales/en.json";

// The toggle to a tool call's kept whole result, on the conversation page.

afterEach(() => {
  cleanup();
});

async function inEnglish(ui: ReactNode) {
  const i = i18next.createInstance();
  await i.init({
    lng: "en",
    resources: { en: { translation: clientEn } },
    interpolation: { escapeValue: false },
  });
  return render(<I18nextProvider i18n={i}>{ui}</I18nextProvider>);
}

describe("ToolCallDetails with a kept whole result", () => {
  test("an empty logged copy still offers the kept result", async () => {
    // Debug logging's row budget can be spent on the arguments, leaving `output` empty.
    await inEnglish(
      <ToolCallDetails
        args={{ evento: "show" }}
        output=""
        fullOutput="INICIO resultado inteiro FIM"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /whole result/i }));
    expect(screen.getByText("INICIO resultado inteiro FIM")).toBeTruthy();
  });

  test("a kept copy past its ceiling is not called the whole result", async () => {
    await inEnglish(
      <ToolCallDetails
        output="corte…[truncated]"
        fullOutput="primeira parte"
        fullOutputCut
      />,
    );
    expect(screen.queryByRole("button", { name: /whole result/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /kept result/i }).textContent,
    ).toContain("the call returned more");
  });
});
