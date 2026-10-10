/// <reference lib="dom" />

// The "changed elsewhere" card sits at the top of the editor, and on a long tab the operator works
// scrolled down by the sticky save bar, where the card is out of view. The bar carries the same
// notice, compact, and both read ONE value from the page: that is what makes "Save anyway shows in
// the bar exactly when it shows in the card" hold by construction instead of by two conditions.

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import {
  type StaleNotice,
  StaleNoticeCard,
  StaleNoticeContext,
  staleNoticeOf,
} from "@/client/pages/agents/StaleNotice";
import { TabActionBar } from "@/client/pages/agents/TabActionBar";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";
import { createTestI18n, withI18n } from "../utils/i18n";

afterEach(cleanup);

function notice(withOverwrite: boolean) {
  return {
    reload: mock(() => {}),
    overwrite: withOverwrite ? mock(() => {}) : null,
    dismiss: mock(() => {}),
  } satisfies StaleNotice;
}

function Bar() {
  return (
    <TabActionBar dirty saving={false} onSave={() => {}} onDiscard={() => {}} />
  );
}

// The page's composition in miniature: the card above, a tab's bar below, one provider around both.
function Page({ value }: { value: StaleNotice | null }) {
  return (
    <StaleNoticeContext.Provider value={value}>
      <StaleNoticeCard notice={value} />
      <Bar />
    </StaleNoticeContext.Provider>
  );
}

describe("the save bar carries the stale notice", () => {
  test("without a notice the bar shows only its own actions", () => {
    render(<Page value={null} />);
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("with a notice the bar shows the short line and a Reload that reloads", () => {
    const n = notice(false);
    const { getByTestId } = render(
      <StaleNoticeContext.Provider value={n}>
        <Bar />
      </StaleNoticeContext.Provider>,
    );
    const strip = getByTestId("stale-notice-strip");
    expect(strip.textContent).toContain("Changed elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(n.reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
    // The bar's own Save is still there, next to the notice.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("Save anyway in the bar runs the same overwrite as the card's", () => {
    const n = notice(true);
    render(<Page value={n} />);
    const [inCard, inBar] = screen.getAllByRole("button", {
      name: "Save anyway",
    });
    fireEvent.click(inBar as HTMLElement);
    fireEvent.click(inCard as HTMLElement);
    expect(n.overwrite).toHaveBeenCalledTimes(2);
  });

  test("the bar offers Save anyway exactly when the card does", () => {
    for (const withOverwrite of [false, true]) {
      const { unmount } = render(<Page value={notice(withOverwrite)} />);
      const count = screen.queryAllByRole("button", {
        name: "Save anyway",
      }).length;
      expect({ withOverwrite, count }).toEqual({
        withOverwrite,
        count: withOverwrite ? 2 : 0,
      });
      expect(screen.getAllByRole("button", { name: "Reload" }).length).toBe(2);
      unmount();
    }
  });

  test("clearing the notice clears the card and the bar together", () => {
    const { rerender } = render(<Page value={notice(true)} />);
    expect(screen.getAllByRole("button", { name: "Reload" }).length).toBe(2);
    rerender(<Page value={null} />);
    expect(screen.queryAllByRole("button", { name: "Reload" }).length).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
  });

  test("the card's dismiss goes to the page, which owns the notice", () => {
    const n = notice(false);
    render(<Page value={n} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(n.dismiss).toHaveBeenCalledTimes(1);
  });

  test("the notice wraps onto its own line, so it never pushes Save out of the bar", () => {
    const { getByTestId } = render(<Page value={notice(true)} />);
    const strip = getByTestId("stale-notice-strip");
    // A row of its own above the actions, wrapping inside itself on a narrow viewport, and so do
    // its buttons: Reload and "Salvar assim mesmo" do not fit side by side at 320px.
    expect(strip.className).toContain("flex-wrap");
    const reload = screen.getAllByRole("button", {
      name: "Reload",
    })[1] as HTMLElement;
    expect(strip.contains(reload)).toBe(true);
    expect(reload.parentElement?.className).toContain("flex-wrap");
    const save = screen.getByRole("button", { name: "Save" });
    expect(strip.contains(save)).toBe(false);
    // The actions row wraps too: Test in playground, Discard and Save do not fit 375px on one line.
    const actions = save.parentElement?.parentElement as HTMLElement;
    expect(actions.className).toContain("flex-wrap");
  });
});

describe("the page's state becomes one notice", () => {
  function actions() {
    const calls: string[] = [];
    return {
      calls,
      reload: () => calls.push("reload"),
      clear: () => calls.push("clear"),
      dismiss: () => calls.push("dismiss"),
    };
  }

  test("no notice while the loaded version is current, even with a stashed retry", () => {
    expect(staleNoticeOf(false, () => {}, actions())).toBeNull();
  });

  test("a change seen elsewhere offers Reload and no overwrite", () => {
    const a = actions();
    const n = staleNoticeOf(true, null, a);
    expect(n?.overwrite).toBeNull();
    n?.reload();
    n?.dismiss();
    expect(a.calls).toEqual(["reload", "dismiss"]);
  });

  test("after a refused save the overwrite clears the notice, then re-runs that save", () => {
    const a = actions();
    const n = staleNoticeOf(true, () => a.calls.push("retry"), a);
    n?.overwrite?.();
    expect(a.calls).toEqual(["clear", "retry"]);
  });
});

// The editor itself: a save the server refuses as a conflict raises the notice, and the card at the
// top and every tab's save bar show that one notice and clear together.
describe("the editor wires one notice to both places", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function conflicted(): Promise<void> {
    const stub = stubEditorApi({ settings: {} });
    stub.override = (method, path) =>
      method === "PATCH" && path === `/api/v1/agents/${stub.agent.id}`
        ? new Response(JSON.stringify({ error: "conflict" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          })
        : undefined;
    await renderEditor(stub, "general");
    fireEvent.change(screen.getByDisplayValue("Atendente"), {
      target: { value: "Atendente 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("stale-notice-strip");
  }
  const card = () =>
    screen
      .queryAllByRole("alert")
      .find((el) =>
        el.textContent?.includes("This agent was changed elsewhere"),
      );
  const shown = () => ({
    card: card() !== undefined,
    bar: screen.queryAllByTestId("stale-notice-strip").length,
    saveAnyway: screen.queryAllByRole("button", { name: "Save anyway" }).length,
  });

  test("the card and the provider read the same value", async () => {
    await conflicted();
    expect(shown()).toEqual({ card: true, bar: 1, saveAnyway: 2 });
    fireEvent.click(
      within(card() as HTMLElement).getByRole("button", { name: "Dismiss" }),
    );
    expect(shown()).toEqual({ card: false, bar: 0, saveAnyway: 0 });
  });

  test("the provider wraps the whole page, and the page holds every tab that renders a save bar", async () => {
    await conflicted();
    for (const tab of [
      /General/,
      /Tools/,
      /Knowledge/,
      /Behavior/,
      /Guardrails/,
      /Channel redirect|Redirect/,
    ]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      await act(async () => {});
      expect({ tab: String(tab), bar: shown().bar }).toEqual({
        tab: String(tab),
        bar: 1,
      });
    }
  });
});

// The bar's short line is its own sentence in each locale, read where the bar draws it.
describe("both locales carry the short line", () => {
  test("en and pt-BR each have their own text for editor.staleShort", () => {
    const lines: Record<string, string> = {};
    for (const [lng, translation] of [
      ["en", en],
      ["pt-BR", ptBR],
    ] as const) {
      const { unmount, getByTestId } = render(
        withI18n(
          <StaleNoticeContext.Provider value={notice(false)}>
            <Bar />
          </StaleNoticeContext.Provider>,
          createTestI18n(lng, { [lng]: { translation } }),
        ),
      );
      lines[lng] = (getByTestId("stale-notice-strip").textContent ?? "")
        .replace("Recarregar", "")
        .replace("Reload", "")
        .trim();
      unmount();
    }
    expect(lines.en).toBe("Changed elsewhere");
    expect((lines["pt-BR"] ?? "").length).toBeGreaterThan(0);
    expect(lines["pt-BR"]).not.toBe(lines.en);
  });
});
