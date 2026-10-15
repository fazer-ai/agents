/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { WebhookEventPicker } from "@/client/components/webhooks/WebhookEventPicker";
import type { WebhookEventGroup } from "@/client/lib/webhookEventGroups";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { createTestI18n, withI18n } from "@/tests/utils/i18n";

// The event picker groups the catalog by family: collapsed groups with an "N of M" count, an "all" box
// that stores the family wildcard and says it includes future events, and a search that hides rows
// without dropping what they hold. Every assertion reduces to a string, a number or a boolean.

const GROUPS: WebhookEventGroup[] = [
  {
    family: "conversation",
    wildcard: "conversation.*",
    events: [
      "conversation.created",
      "conversation.status_changed",
      "conversation.handoff",
    ],
  },
  {
    family: "document",
    wildcard: "document.*",
    events: [
      "document.approval_requested",
      "document.approval_decided",
      "document.approval_outcome",
    ],
  },
  { family: null, wildcard: null, events: ["heartbeat"] },
];

let current: string[] = [];

function Harness({ initial }: { initial: string[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  current = [...selected].sort();
  return (
    <TooltipPrimitive.Provider>
      <WebhookEventPicker
        groups={GROUPS}
        selected={selected}
        onChange={setSelected}
      />
    </TooltipPrimitive.Provider>
  );
}

function mount(initial: string[], lng = "en") {
  const i18n = createTestI18n(lng, {
    en: { translation: en },
    "pt-BR": { translation: ptBR },
  });
  return render(withI18n(<Harness initial={initial} />, i18n));
}

const group = (family: string) => {
  const el = document.querySelector(`[data-family="${family}"]`);
  if (!el) throw new Error(`no group ${family}`);
  return el as HTMLElement;
};
const header = (family: string) =>
  within(group(family)).getAllByRole("button")[0] as HTMLButtonElement;
const allBox = (family: string) =>
  within(group(family)).getAllByRole("checkbox")[0] as HTMLInputElement;
const rows = (family: string) =>
  within(group(family))
    .queryAllByRole("listitem")
    .map((li) => li.textContent ?? "");

describe("the webhook event picker", () => {
  afterEach(() => {
    cleanup();
    current = [];
  });

  test("groups open only where something is selected, and say how much is covered", () => {
    mount(["document.approval_decided"]);
    expect(header("conversation").getAttribute("aria-expanded")).toBe("false");
    expect(header("document").getAttribute("aria-expanded")).toBe("true");
    expect(header("document").textContent).toContain("1 of 3");
    expect(allBox("document").indeterminate).toBe(true);
    expect(allBox("conversation").indeterminate).toBe(false);
    expect(allBox("conversation").checked).toBe(false);
  });

  test("checking all stores the wildcard and says it includes future events", () => {
    mount([]);
    fireEvent.click(allBox("document"));
    expect(current).toEqual(["document.*"]);
    expect(allBox("document").checked).toBe(true);
    expect(header("document").textContent).toContain(
      "All, includes future events",
    );
  });

  test("unchecking one event under the wildcard keeps the others, explicitly", () => {
    mount(["document.*"]);
    const outcome = within(group("document"))
      .getAllByRole("checkbox")
      .find((b) =>
        b.closest("li")?.textContent?.includes("Document approval outcome"),
      );
    if (!outcome) throw new Error("no outcome row");
    fireEvent.click(outcome);
    expect(current).toEqual([
      "document.approval_decided",
      "document.approval_requested",
    ]);
    expect(header("document").textContent).toContain("2 of 3");
  });

  test("rows are compact: label and one line on when it fires, the raw name kept out of the text", () => {
    mount(["conversation.created"]);
    const texts = rows("conversation");
    expect(texts.length).toBe(3);
    expect(texts[0]?.startsWith("Conversation created")).toBe(true);
    expect(texts.some((t) => t.includes("conversation.created"))).toBe(false);
  });

  test("the search hides rows but keeps what they hold", () => {
    mount(["conversation.created", "document.*"]);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "outcome" },
    });
    expect(document.querySelector('[data-family="conversation"]')).toBeNull();
    expect(rows("document").length).toBe(1);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "" },
    });
    expect(current).toEqual(["conversation.created", "document.*"]);
    expect(screen.queryByText("No event matches the search.") === null).toBe(
      true,
    );
  });

  test("a search opens a group that was closed", () => {
    mount([]);
    expect(rows("conversation").length).toBe(0);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "handed" },
    });
    expect(rows("conversation").length).toBe(1);
  });

  test("Enter in the search does not submit the form around the picker", () => {
    let submitted = 0;
    render(
      withI18n(
        <TooltipPrimitive.Provider>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitted += 1;
            }}
          >
            <WebhookEventPicker
              groups={GROUPS}
              selected={new Set()}
              onChange={() => {}}
            />
            <button type="submit">Save</button>
          </form>
        </TooltipPrimitive.Provider>,
      ),
    );
    const search = screen.getByRole("searchbox");
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(submitted).toBe(0);
  });

  test("a search with no match says so", () => {
    mount([]);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz" },
    });
    expect(screen.queryByText("No event matches the search.") !== null).toBe(
      true,
    );
  });

  test("in Portuguese", () => {
    mount(
      ["document.approval_decided", "document.approval_requested"],
      "pt-BR",
    );
    expect(header("document").textContent).toContain("Documentos");
    expect(header("document").textContent).toContain("2 de 3");
    fireEvent.click(allBox("conversation"));
    expect(header("conversation").textContent).toContain(
      "Todos, inclui eventos futuros",
    );
    expect(document.body.textContent?.includes("webhooks.")).toBe(false);
  });
});
