import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// Every field check the Behavior tab computes reaches its Save button. Rendering a field error is
// not enough: only refusing the save is load-bearing, since a configuration the runtime will not
// build is worth nothing stored (a fallback that cannot be built is the same as none). Each case is
// an agent stored with exactly one thing wrong, opened on the Behavior tab.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const NOT_A_URL = "not a url";
const ELSEWHERE = "https://llm.example.com/v1";

const REFUSED: Array<
  [string, { mode?: string; settings: Record<string, unknown> }]
> = [
  [
    "a transcription endpoint that is not a URL",
    {
      settings: {
        stt: {
          enabled: true,
          provider: "openai-compatible",
          baseURL: NOT_A_URL,
        },
      },
    },
  ],
  [
    "an image-reading endpoint that is not a URL",
    {
      settings: {
        vision: {
          enabled: true,
          provider: "openai-compatible",
          baseURL: NOT_A_URL,
        },
      },
    },
  ],
  [
    "a summariser on a compatible provider with no endpoint",
    {
      settings: {
        memory: {
          compaction: {
            enabled: true,
            provider: "openai-compatible",
            model: "m",
            baseURL: null,
          },
        },
      },
    },
  ],
  [
    "a summariser endpoint on a provider that takes none",
    {
      settings: {
        memory: {
          compaction: {
            enabled: true,
            provider: "anthropic",
            model: "claude-x",
            baseURL: ELSEWHERE,
          },
        },
      },
    },
  ],
  [
    "a fallback on a compatible provider with no endpoint",
    {
      settings: {
        modelFallback: {
          provider: "openai-compatible",
          model: "m",
          baseURL: null,
        },
      },
    },
  ],
  [
    "a fallback endpoint on a provider that takes none",
    {
      settings: {
        modelFallback: {
          provider: "anthropic",
          model: "claude-x",
          baseURL: ELSEWHERE,
        },
      },
    },
  ],
  [
    "a fallback provider with no model",
    { settings: { modelFallback: { provider: "gemini", model: "" } } },
  ],
  [
    "an authorization gate with neither a rule nor an endpoint",
    { settings: { contactAuth: { enabled: true } } },
  ],
  [
    "an authorization endpoint that is not a URL",
    { settings: { contactAuth: { enabled: true, url: NOT_A_URL } } },
  ],
  [
    "a speech rewrite on a compatible provider with no endpoint",
    {
      settings: {
        tts: {
          mode: "mirror",
          normalize: true,
          normalizeProvider: "openai-compatible",
          normalizeModel: "m",
          normalizeBaseURL: null,
        },
      },
    },
  ],
  [
    "a speech rewrite endpoint on a provider that takes none",
    {
      settings: {
        tts: {
          mode: "mirror",
          normalize: true,
          normalizeProvider: "anthropic",
          normalizeModel: "claude-x",
          normalizeBaseURL: ELSEWHERE,
        },
      },
    },
  ],
  [
    "a watcher's decisions block the server would refuse",
    {
      mode: "monitoring",
      settings: {
        monitoring: {
          engine: "decisions",
          decisions: {
            provider: "typesafe",
            credentialRef: "vault:1",
            questions: [],
            rules: [],
            apply: "shadow",
          },
        },
      },
    },
  ],
];

async function saveDisabled(agent: {
  mode?: string;
  settings: Record<string, unknown>;
}): Promise<boolean> {
  const stub = stubEditorApi(agent);
  await renderEditor(stub, "behavior");
  return (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
    .disabled;
}

describe("the Behavior tab's save gate", () => {
  for (const [what, agent] of REFUSED) {
    test(`${what} blocks the save`, async () => {
      expect(await saveDisabled(agent)).toBe(true);
    });
  }

  // A stored rule the reader would drop reads as no rule, so the bad rule is a draft: a label
  // condition whose label is erased.
  test("an authorization rule the server would refuse blocks the save", async () => {
    const stub = stubEditorApi({
      settings: {
        contactAuth: { enabled: true, rule: { kind: "label", label: "vip" } },
      },
    });
    await renderEditor(stub, "behavior");
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByDisplayValue("vip"), {
      target: { value: "" },
    });
    expect(save.disabled).toBe(true);
  });

  test("a valid agent, and a valid watcher, can save", async () => {
    expect(await saveDisabled({ settings: {} })).toBe(false);
    cleanup();
    expect(await saveDisabled({ mode: "monitoring", settings: {} })).toBe(
      false,
    );
  });

  // A watcher draws no speech section, so a leftover bad rewrite on it has no field to explain a
  // disabled Save.
  test("a watcher's leftover speech rewrite does not block its save", async () => {
    expect(
      await saveDisabled({
        mode: "monitoring",
        settings: {
          tts: {
            mode: "mirror",
            normalize: true,
            normalizeProvider: "openai-compatible",
            normalizeModel: "m",
            normalizeBaseURL: null,
          },
        },
      }),
    ).toBe(false);
  });
});
