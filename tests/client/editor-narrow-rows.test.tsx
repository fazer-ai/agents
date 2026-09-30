/// <reference lib="dom" />

// The agent editor's rows that grow with state (the header once the form is dirty, the "changed
// elsewhere" card after a refused save) wrap, so at 320px in pt-BR nothing past the edge makes the
// main area scroll sideways. A row without `flex-wrap` keeps its buttons on one line however narrow
// the viewport is.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { StaleNoticeCard } from "@/client/pages/agents/StaleNotice";

afterEach(cleanup);

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

describe("the editor header", () => {
  const SRC = Bun.file("src/client/pages/agents/AgentEditorPage.tsx").text();

  // The markup between the title row's opening and the Export button, which holds both groups.
  async function headerRow() {
    const src = await SRC;
    const start = src.indexOf('<h1 className="truncate');
    const end = src.indexOf('t("editor.export", "Export")', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const open = src.lastIndexOf("<div className=", start);
    const groupOpen = src.lastIndexOf(
      "<div className=",
      src.indexOf("{anyDirty && (\n                  <Button", start),
    );
    return {
      src,
      titleGroup: src.slice(open, src.indexOf(">", open)),
      actions: src.slice(groupOpen, src.indexOf(">", groupOpen)),
      end,
    };
  }

  test("the title group wraps its badges", async () => {
    const { titleGroup } = await headerRow();
    expect(titleGroup).toContain("flex-wrap");
    expect(titleGroup).toContain("min-w-0");
  });

  test("the actions group wraps Discard all, Clone and Export", async () => {
    const { actions } = await headerRow();
    expect(actions).toContain("flex-wrap");
  });
});

describe("the General tab", () => {
  test("the mode selector wraps inside the card instead of running past it", async () => {
    const src = await Bun.file("src/client/pages/agents/GeneralTab.tsx").text();
    const at = src.indexOf("{AGENT_MODES.map(");
    const open = src.lastIndexOf("<div className=", at);
    const cls = src.slice(open, src.indexOf(">", open));
    expect(cls).toContain("flex-wrap");
    expect(cls).toContain("max-w-full");
  });

  test("the capability map's title row wraps View graph under the title", async () => {
    const src = await Bun.file(
      "src/client/pages/agents/CapabilityMap.tsx",
    ).text();
    const at = src.indexOf('<Card id="general-capabilities"');
    const open = src.indexOf("<div className=", at);
    expect(src.slice(open, src.indexOf(">", open))).toContain("flex-wrap");
  });
});
