/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The Call settings tab plays each sound preset before it is chosen, from where ElevenLabs serves it:
// a control on each preset's row and one beside the field for the preset chosen. Listening never
// chooses, the "none" options have nothing to play, and one sample plays at a time.

const CDN =
  "https://eleven-public-cdn-common.elevenlabs.io/convai/ambient-audio-assets";

const realFetch = globalThis.fetch;
const realPlay = HTMLMediaElement.prototype.play;
const realPause = HTMLMediaElement.prototype.pause;
let played: string[] = [];
let pauses = 0;
let lastAudio: HTMLMediaElement | null = null;

beforeEach(() => {
  played = [];
  pauses = 0;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    played.push(this.src);
    lastAudio = this;
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = () => {
    pauses++;
  };
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  HTMLMediaElement.prototype.play = realPlay;
  HTMLMediaElement.prototype.pause = realPause;
});

async function open(sounds: { backgroundSound?: string; toolSound?: string }) {
  const stub = stubEditorApi({
    kind: "voice",
    settings: {
      calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini", ...sounds },
    },
  });
  stub.override = (method, path) =>
    method === "POST" && path.endsWith("/calls/check")
      ? new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : undefined;
  await renderEditor(stub, "call");
  await act(async () => {});
  return stub;
}

async function openList(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.findByRole("menu");
}

const field = (name: string) =>
  screen.getByRole("button", { name, hidden: true });

describe("sound samples", () => {
  test("each background preset plays its own file, and listening does not choose it", async () => {
    await open({ backgroundSound: "" });
    const menu = await openList("Background");
    const rows = within(menu).getAllByRole("menuitemcheckbox");
    expect(rows).toHaveLength(9);
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", {
        name: "Play a sample of Street",
      }),
    );
    expect(played).toEqual([`${CDN}/city.mp3`]);
    expect(field("Background").textContent).toContain("None");
    const playing = within(menu).getByRole("menuitemcheckbox", {
      name: "Stop the sample of Street",
    });
    expect(playing.getAttribute("aria-checked")).toBe("true");
  });

  test("each lookup sound plays its own file", async () => {
    await open({});
    const menu = await openList("Sound during lookups");
    expect(within(menu).getAllByRole("menuitemcheckbox")).toHaveLength(5);
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", {
        name: "Play a sample of Hold music 2",
      }),
    );
    expect(played).toEqual([`${CDN}/elevator2.mp3`]);
  });

  test("None and Silence have nothing to play", async () => {
    await open({});
    let menu = await openList("Background");
    expect(
      within(menu).queryByRole("menuitemcheckbox", { name: /None/ }),
    ).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /None/ })).not.toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await act(async () => {});
    menu = await openList("Sound during lookups");
    expect(
      within(menu).queryByRole("menuitemcheckbox", { name: /Silence/ }),
    ).toBeNull();
    // Neither field offers a Listen button while nothing is chosen.
    expect(
      screen.queryByRole("button", { name: /Play a sample/, hidden: true }),
    ).toBeNull();
  });

  test("the chosen preset plays beside the field, and pressing again stops it", async () => {
    await open({ backgroundSound: "restaurant" });
    const button = screen.getByRole("button", {
      name: "Play a sample of Restaurant",
    });
    expect(button.textContent).toBe("Listen");
    fireEvent.click(button);
    expect(played).toEqual([`${CDN}/restaurant.mp3`]);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("one sample at a time, across the two fields", async () => {
    await open({ backgroundSound: "office1", toolSound: "typing" });
    const background = screen.getByRole("button", {
      name: "Play a sample of Office",
    });
    const lookup = screen.getByRole("button", {
      name: "Play a sample of Typing",
    });
    fireEvent.click(background);
    fireEvent.click(lookup);
    expect(played).toEqual([`${CDN}/office1.mp3`, `${CDN}/typing.mp3`]);
    expect([
      background.getAttribute("aria-pressed"),
      lookup.getAttribute("aria-pressed"),
    ]).toEqual(["false", "true"]);
  });

  test("a preset that fails to load frees its control", async () => {
    await open({ backgroundSound: "city" });
    const button = screen.getByRole("button", {
      name: "Play a sample of Street",
    });
    fireEvent.click(button);
    await act(async () => {
      lastAudio?.dispatchEvent(new Event("error"));
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("choosing another option stops the sample of the one it replaced, and picking the one playing keeps it", async () => {
    await open({});
    let menu = await openList("Background");
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", {
        name: "Play a sample of Restaurant",
      }),
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Restaurant/ }));
    await act(async () => {});
    const playing = screen.getByRole("button", {
      name: "Stop the sample of Restaurant",
    });
    expect(playing.getAttribute("aria-pressed")).toBe("true");
    const before = pauses;
    menu = await openList("Background");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /None/ }));
    await act(async () => {});
    expect(pauses).toBe(before + 1);
  });

  test("the same preset in both fields: only the control pressed shows Stop, and the other takes it over", async () => {
    await open({ toolSound: "typing" });
    const lookup = screen.getByRole("button", {
      name: "Play a sample of Typing",
    });
    const menu = await openList("Background");
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", {
        name: "Play a sample of Typing",
      }),
    );
    expect(lookup.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(lookup);
    expect(played).toEqual([`${CDN}/typing.mp3`, `${CDN}/typing.mp3`]);
    expect(lookup.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: "Play a sample of Typing" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("leaving the tab stops the sample it started", async () => {
    await open({ toolSound: "typing" });
    fireEvent.click(
      screen.getByRole("button", { name: "Play a sample of Typing" }),
    );
    const before = pauses;
    cleanup();
    expect(pauses).toBe(before + 1);
  });

  test("choosing a preset in the list is what gets saved", async () => {
    const stub = await open({});
    const menu = await openList("Background");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Restaurant/ }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        (
          lastSavedSettings(stub)?.calls as
            | { backgroundSound?: string }
            | undefined
        )?.backgroundSound,
      ).toBe("restaurant"),
    );
  });
});
