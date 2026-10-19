/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TtsOptionPicker } from "@/client/pages/agents/BehaviorTab";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";
import { createTestI18n, withI18n } from "../utils/i18n";

// The Voice card plays the sample ElevenLabs ships for a voice: beside the field for the chosen one,
// and on each row of the list. Listening never chooses, and a sample that fails frees its control.

const A = "https://samples.test/a.mp3";
const B = "https://samples.test/b.mp3";
const A_PT_BR = "https://samples.test/a-pt-br.mp3";
const A_PT_PT = "https://samples.test/a-pt-pt.mp3";

const realFetch = globalThis.fetch;
const realPlay = HTMLMediaElement.prototype.play;
const realPause = HTMLMediaElement.prototype.pause;
let pauses = 0;
let played: string[] = [];
let lastAudio: HTMLMediaElement | null = null;
let playResult: () => Promise<void> = async () => {};

beforeEach(() => {
  played = [];
  pauses = 0;
  HTMLMediaElement.prototype.pause = () => {
    pauses++;
  };
  playResult = async () => {};
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    played.push(this.src);
    lastAudio = this;
    return playResult();
  };
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  HTMLMediaElement.prototype.play = realPlay;
  HTMLMediaElement.prototype.pause = realPause;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function open(voice = "a", language = "en") {
  const stub = stubEditorApi({
    kind: "voice",
    settings: {
      calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini", voice },
    },
  });
  stub.override = (method, path) =>
    method === "POST" && path.endsWith("/tts/list")
      ? json({
          instance: {},
          items: [
            {
              id: "a",
              label: "Raquel",
              previewUrl: A,
              languageSamples: [
                { language: "pt", locale: "pt-PT", url: A_PT_PT },
                { language: "pt", locale: "pt-BR", url: A_PT_BR },
              ],
            },
            { id: "b", label: "Bruno", previewUrl: B },
            { id: "c", label: "Clone" },
          ],
        })
      : undefined;
  const i18n = createTestI18n(language);
  await renderEditor(stub, "general", i18n);
  await act(async () => {});
  return Object.assign(stub, { i18n });
}

const writes = (requests: string[]) =>
  requests.filter((r) => /^(PATCH|PUT|POST) .*\/agents\/\d+$/.test(r));

describe("the voice sample", () => {
  test("the button beside the field plays the chosen voice, and pressing it again stops it", async () => {
    await open();
    const button = await screen.findByRole("button", {
      name: "Play a sample of Raquel",
    });
    fireEvent.click(button);
    expect(played).toEqual([A]);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Stop the sample of Raquel" }),
    );
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("a row's sample plays that voice without choosing it", async () => {
    const stub = await open();
    await screen.findByRole("button", { name: "Play a sample of Raquel" });
    const before = writes(stub.requests).length;
    fireEvent.pointerDown(screen.getByRole("button", { name: "Voice" }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", {
        name: "Play a sample of Bruno",
      }),
    );
    expect(played).toEqual([B]);
    expect(screen.queryByRole("menu")).not.toBeNull();
    // The open menu hides the rest of the page from the accessibility tree, the trigger included.
    expect(
      screen.getByRole("button", { name: "Voice", hidden: true }).textContent,
    ).toContain("Raquel");
    expect(writes(stub.requests).length).toBe(before);
    // A voice the provider ships no sample for has no control to press.
    expect(
      within(menu).queryByRole("menuitemcheckbox", { name: /sample of Clone/ }),
    ).toBeNull();
  });

  test("the button follows a newly chosen voice before saving", async () => {
    await open();
    await screen.findByRole("button", { name: "Play a sample of Raquel" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Voice" }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Bruno/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Play a sample of Bruno" }),
    );
    expect(played).toEqual([B]);
  });

  test("a sample that fails to load frees its control", async () => {
    await open();
    const button = await screen.findByRole("button", {
      name: "Play a sample of Raquel",
    });
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      lastAudio?.dispatchEvent(new Event("error"));
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("a play the browser refuses frees its control", async () => {
    playResult = () => Promise.reject(new Error("NotAllowedError"));
    await open();
    const button = await screen.findByRole("button", {
      name: "Play a sample of Raquel",
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("switching samples keeps the new one on when the browser aborts the old one late", async () => {
    let abortFirst: (e: Error) => void = () => {};
    playResult = () =>
      new Promise<void>((_, reject) => {
        abortFirst = reject;
      });
    await open();
    await screen.findByRole("button", { name: "Play a sample of Raquel" });
    fireEvent.click(
      screen.getByRole("button", { name: "Play a sample of Raquel" }),
    );
    playResult = async () => {};
    fireEvent.pointerDown(screen.getByRole("button", { name: "Voice" }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole("menu");
    const bruno = within(menu).getByRole("menuitemcheckbox", {
      name: "Play a sample of Bruno",
    });
    fireEvent.click(bruno);
    await act(async () => {
      abortFirst(new Error("AbortError"));
    });
    expect(bruno.getAttribute("aria-checked")).toBe("true");
  });

  test("a row's sample is reached from the keyboard, and Enter plays it without choosing it", async () => {
    await open();
    await screen.findByRole("button", { name: "Play a sample of Raquel" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Voice" }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole("menu");
    // A menu item of its own: the arrow keys walk menu items, and only menu items.
    const bruno = within(menu).getByRole("menuitemcheckbox", {
      name: "Play a sample of Bruno",
    });
    bruno.focus();
    fireEvent.keyDown(bruno, { key: "Enter" });
    expect(played).toEqual([B]);
    expect(screen.queryByRole("menu")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Voice", hidden: true }).textContent,
    ).toContain("Raquel");
  });

  test("switching the console's language stops a sample the picker started", async () => {
    const stub = await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Play a sample of Raquel" }),
    );
    const before = pauses;
    await act(async () => {
      await stub.i18n.changeLanguage("pt-BR");
    });
    expect(pauses).toBe(before + 1);
    expect(
      screen
        .getByRole("button", { name: /Raquel/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("choosing another voice stops the old voice's sample, and keeps the new one's", async () => {
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Play a sample of Raquel" }),
    );
    const before = pauses;
    fireEvent.pointerDown(screen.getByRole("button", { name: "Voice" }), {
      button: 0,
      ctrlKey: false,
    });
    let menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Bruno/ }));
    await act(async () => {});
    expect(pauses).toBe(before + 1);
    // Heard on its row, then chosen: it plays on, and the field's control stops it.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Voice" }), {
      button: 0,
      ctrlKey: false,
    });
    menu = await screen.findByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", {
        name: "Play a sample of Raquel",
      }),
    );
    const playing = pauses;
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Raquel/ }));
    await act(async () => {});
    expect(pauses).toBe(playing);
    expect(
      screen
        .getByRole("button", { name: "Stop the sample of Raquel" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("a picker that goes away stops only its own sample, not the same voice another picker is playing", async () => {
    globalThis.fetch = (async () =>
      json({
        instance: {},
        items: [{ id: "a", label: "Raquel", previewUrl: A }],
      })) as unknown as typeof fetch;
    const picker = (label: string) => (
      <TtsOptionPicker
        kind="voices"
        provider="elevenlabs"
        credentialRef="vault:1"
        value="a"
        onChange={() => {}}
        ariaLabel={label}
      />
    );
    const view = render(
      withI18n(
        <>
          {picker("Primary")}
          {picker("Fallback")}
        </>,
      ),
    );
    const [primary, fallback] = await screen.findAllByRole("button", {
      name: "Play a sample of Raquel",
    });
    // The fallback plays and stops it; then the primary plays the same voice.
    fireEvent.click(fallback as HTMLElement);
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Stop the sample of Raquel",
      })[1] as HTMLElement,
    );
    fireEvent.click(primary as HTMLElement);
    const before = pauses;
    // The fallback goes away (disabled): the primary's sample plays on.
    view.rerender(withI18n(picker("Primary")));
    await act(async () => {});
    expect(pauses).toBe(before);
    expect(
      screen
        .getByRole("button", { name: "Stop the sample of Raquel" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("leaving the page stops the sample it started", async () => {
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Play a sample of Raquel" }),
    );
    const before = pauses;
    cleanup();
    expect(pauses).toBe(before + 1);
  });

  test("an operator reading the console in Brazilian Portuguese hears the voice in Brazilian Portuguese", async () => {
    await open("a", "pt-BR");
    fireEvent.click(
      await screen.findByRole("button", { name: /Raquel/, pressed: false }),
    );
    expect(played).toEqual([A_PT_BR]);
  });

  test("the button beside the field says what it does in words", async () => {
    await open();
    const button = await screen.findByRole("button", {
      name: "Play a sample of Raquel",
    });
    expect(button.textContent).toBe("Listen");
    fireEvent.click(button);
    expect(button.textContent).toBe("Stop");
  });

  test("a voice with no sample shows no button beside the field", async () => {
    await open("c");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Voice" }).textContent,
      ).toContain("Clone"),
    );
    expect(screen.queryByRole("button", { name: /Play a sample/ })).toBeNull();
  });
});
