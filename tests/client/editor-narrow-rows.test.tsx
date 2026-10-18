/// <reference lib="dom" />

// The agent editor's rows that grow with state (the header once the form is dirty, the "changed
// elsewhere" card after a refused save) wrap, so at 320px in pt-BR nothing past the edge makes the
// main area scroll sideways. A row without `flex-wrap` keeps its buttons on one line however narrow
// the viewport is.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StaleNoticeCard } from "@/client/pages/agents/StaleNotice";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("the changed-elsewhere card", () => {
  test("its buttons wrap, with Save anyway shown", () => {
    render(
      <StaleNoticeCard
        notice={{ reload: () => {}, overwrite: () => {}, dismiss: () => {} }}
      />,
    );
    const row = screen.getByRole("button", { name: "Reload" })
      .parentElement as HTMLElement;
    expect(
      row.contains(screen.getByRole("button", { name: "Save anyway" })),
    ).toBe(true);
    expect(row.contains(screen.getByRole("button", { name: "Dismiss" }))).toBe(
      true,
    );
    expect(row.className).toContain("flex-wrap");
    // A wrapped line stays against the right edge, under the text, as the unwrapped one sits.
    expect(row.className).toContain("justify-end");
  });
});

// The rows below are read off the rendered editor: the classes each row is given, since happy-dom
// lays nothing out.
const classesOf = (el: Element | null | undefined) =>
  (el?.getAttribute("class") ?? "").split(/\s+/);

describe("the editor header", () => {
  test("the title group wraps its badges", async () => {
    await renderEditor(stubEditorApi({}));
    const title = screen.getByRole("heading", { level: 1, name: "Atendente" });
    const group = classesOf(title.parentElement);
    expect(group).toContain("flex-wrap");
    expect(group).toContain("min-w-0");
  });

  test("the actions group wraps Discard all, Clone and Export", async () => {
    await renderEditor(stubEditorApi({}));
    fireEvent.change(screen.getByDisplayValue("Atendente"), {
      target: { value: "Atendente nova" },
    });
    const discard = await screen.findByRole("button", { name: "Discard all" });
    const row = discard.parentElement;
    expect(
      ["Clone", "Export"].every((name) =>
        row?.contains(screen.getByRole("button", { name })),
      ),
    ).toBe(true);
    expect(classesOf(row)).toContain("flex-wrap");
  });
});

describe("the General tab", () => {
  // Mode is a group of cards (agents#1254): one column on a phone, three side by side from sm up,
  // so it never runs past the card.
  test("the mode cards stack on a phone and sit side by side from sm up", async () => {
    await renderEditor(stubEditorApi({}));
    const cards = classesOf(screen.getByRole("radiogroup", { name: "Mode" }));
    expect(cards).toContain("grid");
    expect(cards).toContain("sm:grid-cols-3");
    // The whole column contract: no column class below sm, so a phone gets the grid's single column.
    expect(cards.filter((c) => /(^|:)grid-cols-/.test(c))).toEqual([
      "sm:grid-cols-3",
    ]);
  });

  test("the capability map's title row wraps View graph under the title", async () => {
    await renderEditor(stubEditorApi({}));
    const card = document.getElementById("general-capabilities");
    expect(classesOf(card?.firstElementChild)).toContain("flex-wrap");
  });
});
