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

// The two kinds of conversation note: the same three formats on two identical selects, the stored
// value shown, the pick handed to the form with the other kind left as it was, and no section on a
// watcher's screen, whose runs post no such message.

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

const TOOLS = /^(Tools used in each turn|Ferramentas usadas em cada turno)$/;
const ERRORS = /^(Errors in the middle of a turn|Erros no meio do turno)$/;
const select = (label: RegExp) =>
  screen.getByLabelText(label) as HTMLSelectElement;

describe("the Behavior tab's conversation notes", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("two selects with the same three formats, each showing what is stored", () => {
    render(
      <BehaviorTab
        {...behaviorTabProps({})}
        mode="production"
        conversationNotes={{ toolsUsed: "note", errors: "activity" }}
      />,
    );
    const el = document.getElementById("conversationNotes");
    expect(el?.className.split(/\s+/).includes("hidden")).toBe(false);
    const options = (s: HTMLSelectElement) =>
      [...s.options].map((o) => [o.value, o.text]);
    expect(options(select(TOOLS))).toEqual(options(select(ERRORS)));
    expect(options(select(TOOLS)).map(([v]) => v)).toEqual([
      "off",
      "activity",
      "note",
    ]);
    expect(select(TOOLS).value).toBe("note");
    expect(select(ERRORS).value).toBe("activity");
  });

  test("a pick changes its own kind and leaves the other as it was", () => {
    const calls: unknown[] = [];
    render(
      <BehaviorTab
        {...behaviorTabProps({})}
        mode="production"
        conversationNotes={{ toolsUsed: "off", errors: "note" }}
        setConversationNotes={(v) => calls.push(v)}
      />,
    );
    fireEvent.change(select(TOOLS), { target: { value: "activity" } });
    fireEvent.change(select(ERRORS), { target: { value: "off" } });
    expect(calls).toEqual([
      { toolsUsed: "activity", errors: "note" },
      { toolsUsed: "off", errors: "off" },
    ]);
  });

  test("is not offered to a monitoring agent", () => {
    render(<BehaviorTab {...behaviorTabProps({})} mode="monitoring" />);
    const el = document.getElementById("conversationNotes");
    expect(el?.className.split(/\s+/).includes("hidden")).toBe(true);
  });

  test("the help about the formats names the Chatwoot version, never the fork", async () => {
    const en = (await Bun.file("src/client/locales/en.json").json()).editor;
    const pt = (await Bun.file("src/client/locales/pt-BR.json").json()).editor;
    expect(en.conversationNoteFormatActivityContact).toBe(
      "In the current Chatwoot version, an activity message shows as sent by the contact, and in a follow-up it also updates the contact's last activity.",
    );
    expect(pt.conversationNoteFormatActivityContact).toBe(
      "Na versão atual do Chatwoot, a mensagem de atividade aparece como enviada pelo contato e, num follow-up, também atualiza a última atividade dele.",
    );
    for (const key of Object.keys(en).filter((k) =>
      k.startsWith("conversationNote"),
    )) {
      expect(en[key]).not.toMatch(/\bfork\b/i);
      expect(pt[key]).not.toMatch(/\bfork\b/i);
    }
  });
});
