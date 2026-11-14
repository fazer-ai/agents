/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  test("an empty logged copy still offers the kept result, fetched on the first click only", async () => {
    // Debug logging's row budget can be spent on the arguments, leaving `output` empty.
    let loads = 0;
    await inEnglish(
      <ToolCallDetails
        args={{ evento: "show" }}
        output=""
        fullOutputChars={28}
        loadFullOutput={async () => {
          loads++;
          return "INICIO resultado inteiro FIM";
        }}
      />,
    );
    expect(loads).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /whole result/i }));
    await waitFor(() =>
      expect(screen.getByText("INICIO resultado inteiro FIM")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /cut result/i }));
    fireEvent.click(screen.getByRole("button", { name: /whole result/i }));
    await waitFor(() =>
      expect(screen.getByText("INICIO resultado inteiro FIM")).toBeTruthy(),
    );
    expect(loads).toBe(1);
  });

  test("a result that expired between the refresh and the click says so", async () => {
    await inEnglish(
      <ToolCallDetails
        output="corte…[truncated]"
        fullOutputChars={50_000}
        loadFullOutput={async () => null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /whole result/i }));
    await waitFor(() =>
      expect(screen.getByText(/could not be loaded/i)).toBeTruthy(),
    );
  });

  test("a kept copy past its ceiling is not called the whole result", async () => {
    await inEnglish(
      <ToolCallDetails
        output="corte…[truncated]"
        fullOutputChars={500_000}
        loadFullOutput={async () => "primeira parte"}
        fullOutputCut
      />,
    );
    expect(screen.queryByRole("button", { name: /whole result/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /kept result/i }).textContent,
    ).toContain("the call returned more");
  });
});
