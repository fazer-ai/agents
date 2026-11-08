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
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import { behaviorTabProps } from "./behaviorTabProps";

// The switch that turns on the tools-used note: off as the agent stored it, on when flipped, and not
// on a watcher's screen, whose runs post no such note.

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

const LABEL =
  /^(Leave a note with the tools used in each turn|Deixar uma nota com as ferramentas usadas em cada turno)$/;

function switchOf(): HTMLElement {
  const label = screen.getByText(LABEL);
  const id = label.getAttribute("for") as string;
  return document.getElementById(id) as HTMLElement;
}

describe("the Behavior tab's conversation notes", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("shows the stored value and hands the flip to the form", () => {
    const calls: unknown[] = [];
    render(
      <BehaviorTab
        {...behaviorTabProps({})}
        mode="production"
        conversationNotes={{ toolsUsed: false, errors: "off" }}
        setConversationNotes={(v) => calls.push(v)}
      />,
    );
    const el = document.getElementById("conversationNotes");
    expect(el?.className.split(/\s+/).includes("hidden")).toBe(false);
    const sw = switchOf();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(calls).toEqual([{ toolsUsed: true, errors: "off" }]);
  });

  test("reads on when the agent has it on", () => {
    render(
      <BehaviorTab
        {...behaviorTabProps({})}
        mode="production"
        conversationNotes={{ toolsUsed: true, errors: "off" }}
      />,
    );
    expect(switchOf().getAttribute("aria-checked")).toBe("true");
  });

  test("the errors format: three choices, the stored one shown, the pick handed to the form", () => {
    const calls: unknown[] = [];
    render(
      <BehaviorTab
        {...behaviorTabProps({})}
        mode="production"
        conversationNotes={{ toolsUsed: true, errors: "off" }}
        setConversationNotes={(v) => calls.push(v)}
      />,
    );
    const select = screen.getByLabelText(
      /^(Errors in the middle of a turn|Erros no meio do turno)$/,
    ) as HTMLSelectElement;
    expect(select.value).toBe("off");
    expect([...select.options].map((o) => o.value)).toEqual([
      "off",
      "activity",
      "note",
    ]);
    fireEvent.change(select, { target: { value: "note" } });
    // NOTE: The tools-used switch is left as it was.
    expect(calls).toEqual([{ toolsUsed: true, errors: "note" }]);
  });

  test("is not offered to a monitoring agent", () => {
    render(<BehaviorTab {...behaviorTabProps({})} mode="monitoring" />);
    const el = document.getElementById("conversationNotes");
    expect(el?.className.split(/\s+/).includes("hidden")).toBe(true);
  });
});
