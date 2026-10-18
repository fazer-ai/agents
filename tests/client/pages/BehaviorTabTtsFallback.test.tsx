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
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import {
  readTtsFormState,
  type TtsFormState,
} from "@/client/pages/agents/ttsFormState";
import { behaviorTabProps } from "./behaviorTabProps";

// The timeout and the fallback voice sit with the audio reply settings: the timeout as a number of
// seconds, the fallback as a provider pick that draws its key, voice and model once chosen.

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

function renderTab(stored: Record<string, unknown> = {}) {
  let tts: TtsFormState = readTtsFormState({ mode: "mirror", ...stored });
  const setTts = (next: unknown) => {
    tts =
      typeof next === "function"
        ? (next as (p: TtsFormState) => TtsFormState)(tts)
        : (next as TtsFormState);
  };
  const view = render(
    <AuthContext.Provider
      value={{ ttsCheck: { configured: false, mode: "off" } } as never}
    >
      <BehaviorTab {...behaviorTabProps({ tts, setTts: setTts as never })} />
    </AuthContext.Provider>,
  );
  return { current: () => tts, view };
}

const fallbackSelect = () =>
  screen.getByLabelText(/^Fallback voice(?! id)/) as HTMLSelectElement;

describe("the TTS timeout and fallback voice in the agent editor", () => {
  test("the timeout shows the stored seconds, and typing one reaches the form", () => {
    const { current } = renderTab({ timeoutMs: 15_000 });
    const input = screen.getByLabelText(
      /^Timeout per attempt/,
    ) as HTMLInputElement;
    expect(input.value).toBe("15");
    fireEvent.change(input, { target: { value: "20" } });
    expect(current().timeoutSeconds).toBe("20");
  });

  test("no fallback draws only the provider pick; picking one reaches the form", () => {
    const { current } = renderTab();
    expect(fallbackSelect().value).toBe("");
    expect(screen.queryByText("Fallback API key")).toBeNull();
    fireEvent.change(fallbackSelect(), { target: { value: "elevenlabs" } });
    expect(current().fallbackProvider).toBe("elevenlabs");
  });

  test("a stored fallback draws its key, voice and model", () => {
    renderTab({
      fallbackProvider: "openai",
      fallbackModel: "tts-1",
    });
    expect(fallbackSelect().value).toBe("openai");
    expect(screen.getByText("Fallback API key")).toBeTruthy();
    expect(screen.getByText("Fallback voice id")).toBeTruthy();
    expect(screen.getByText("Fallback model")).toBeTruthy();
  });
});
