/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthContext } from "@/client/contexts/AuthContext";
import clientPt from "@/client/locales/pt-BR.json";
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import {
  readTtsFormState,
  type TtsFormState,
} from "@/client/pages/agents/ttsFormState";
import type { TtsCheckMode } from "@/modules/tts/settings-shared";
import { behaviorTabProps } from "./behaviorTabProps";

// Issue #802: the audio check is picked per agent, next to the audio reply settings, and an install
// with no detector still shows the field, disabled, with what is missing and where to read about it.

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = stubFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(cleanup);

function renderTab(
  ttsCheck: { configured: boolean; mode: TtsCheckMode },
  stored: Record<string, unknown> = {},
) {
  let tts: TtsFormState = readTtsFormState({ mode: "mirror", ...stored });
  const setTts = (next: unknown) => {
    tts =
      typeof next === "function"
        ? (next as (p: TtsFormState) => TtsFormState)(tts)
        : (next as TtsFormState);
  };
  render(
    <AuthContext.Provider value={{ ttsCheck } as never}>
      <BehaviorTab {...behaviorTabProps({ tts, setTts: setTts as never })} />
    </AuthContext.Provider>,
  );
  return () => tts;
}

const field = () => screen.getByLabelText(/^Audio check/) as HTMLSelectElement;

describe("the audio check in the agent editor", () => {
  test("with a detector, the agent can pick a mode, and the default names the instance's", () => {
    const current = renderTab({ configured: true, mode: "shadow" });
    const select = field();
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("");
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual([
      "Instance default (Record only)",
      "Off",
      "Record only",
      "Regenerate",
    ]);
    fireEvent.change(select, { target: { value: "enforce" } });
    expect(current().checkMode).toBe("enforce");
  });

  test("an agent that picked one shows it", () => {
    renderTab({ configured: true, mode: "off" }, { checkMode: "enforce" });
    expect(field().value).toBe("enforce");
  });

  test("with no detector, the field is there, disabled, saying what is missing and where to read", () => {
    renderTab({ configured: false, mode: "off" }, { checkMode: "enforce" });
    const select = field();
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("");
    expect(screen.getByText(/runs no audio detector/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "How to set it up" });
    expect(link.getAttribute("href")).toContain("docs/tts.md");
  });

  test("the pt-BR catalog carries every string of the field", () => {
    const editor = (clientPt as unknown as { editor: Record<string, string> })
      .editor;
    for (const key of [
      "ttsCheckMode",
      "ttsCheckModeHelp",
      "ttsCheckModeUnavailable",
      "ttsCheckModeDocs",
      "ttsCheckModeDefault",
      "ttsCheckOff",
      "ttsCheckShadow",
      "ttsCheckEnforce",
    ]) {
      expect(editor[key]).toBeTruthy();
    }
    expect(editor.ttsCheckModeDefault).toContain("{{mode}}");
  });
});
