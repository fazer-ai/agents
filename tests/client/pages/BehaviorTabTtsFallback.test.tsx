/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { AuthContext } from "@/client/contexts/AuthContext";
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import {
  readTtsFormState,
  type TtsFormState,
} from "@/client/pages/agents/ttsFormState";
import { behaviorTabProps } from "./behaviorTabProps";

// The fallback voice is one block inside Audio replies, laid out like the model fallback: a provider
// pick, then, once one is chosen, its key, voice, model and the per-attempt timeout, stacked in that
// order. The timeout belongs to the fallback, so it is drawn only when there is one.

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
  stored: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) {
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
      <BehaviorTab
        {...behaviorTabProps({ tts, setTts: setTts as never, ...over })}
      />
    </AuthContext.Provider>,
  );
  return { current: () => tts, view };
}

// The block under its own heading: "Provider", "API key" and the rest also label the main voice.
const fallbackBlock = () =>
  screen
    .getByRole("heading", { name: "Fallback voice" })
    .closest("div.border-t") as HTMLElement;
const fallbackSelect = () =>
  within(fallbackBlock()).getByLabelText("Provider") as HTMLSelectElement;
const timeoutInput = (scope: HTMLElement) =>
  within(scope).queryByLabelText(
    /^Timeout per attempt/,
  ) as HTMLInputElement | null;

describe("the fallback voice in the agent editor", () => {
  test("no fallback draws only the provider pick, with no timeout; picking one reaches the form", () => {
    const { current } = renderTab({ fallbackTimeoutMs: 15_000 });
    expect(fallbackSelect().value).toBe("");
    expect(within(fallbackBlock()).queryByText("API key")).toBeNull();
    expect(timeoutInput(fallbackBlock())).toBeNull();
    fireEvent.change(fallbackSelect(), { target: { value: "elevenlabs" } });
    expect(current().fallbackProvider).toBe("elevenlabs");
  });

  test("a stored fallback draws key, voice, model and timeout, stacked in that order", () => {
    renderTab({
      fallbackProvider: "openai",
      fallbackModel: "tts-1",
      fallbackTimeoutMs: 15_000,
    });
    expect(fallbackSelect().value).toBe("openai");
    // A one-control field titles itself with a <label>; a composite one (key, voice, model) is a
    // `role="group"` named by its heading. Both, in document order, are the stacking order.
    const labels = [...fallbackBlock().querySelectorAll("label, [role=group]")]
      .map((el) => {
        const by = el.getAttribute("aria-labelledby");
        const title = by ? document.getElementById(by) : el;
        return title?.textContent?.trim() ?? "";
      })
      .filter((l) =>
        /^(Provider|API key|Voice|Model|Timeout per attempt)/.test(l),
      );
    expect(labels.map((l) => l.split(" (")[0])).toEqual([
      "Provider",
      "API key",
      "Voice",
      "Model",
      "Timeout per attempt",
    ]);
    expect(timeoutInput(fallbackBlock())?.value).toBe("15");
  });

  test("typing a timeout reaches the form", () => {
    const { current } = renderTab({ fallbackProvider: "openai" });
    const input = timeoutInput(fallbackBlock());
    expect(input?.placeholder).toBe("60");
    fireEvent.change(input as HTMLInputElement, { target: { value: "20" } });
    expect(current().fallbackTimeoutSeconds).toBe("20");
  });
});

describe("the model fallback in the agent editor", () => {
  const section = () => document.getElementById("modelFallback") as HTMLElement;

  test("the same timeout field shows once a fallback provider is picked, with the model's default", () => {
    renderTab(
      {},
      {
        modelFallback: {
          provider: "anthropic",
          model: "claude-haiku-5-5",
          credentialRef: "",
          baseURL: "",
          timeoutSeconds: "20",
        },
      },
    );
    const input = timeoutInput(section());
    expect(input?.value).toBe("20");
    expect(input?.placeholder).toBe("45");
  });

  test("without a fallback provider there is no timeout to set", () => {
    renderTab();
    expect(timeoutInput(section())).toBeNull();
  });
});
