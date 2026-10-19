/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { NumberInput, RangeHolds } from "@/client/components";
import { stepsToForm } from "@/client/pages/agents/followUpFormState";
import {
  type EditorBar,
  EditorBarContext,
  TabActionBar,
} from "@/client/pages/agents/TabActionBar";
import { editTab, renderEditor, stubEditorApi } from "../utils/agent-editor";
import { withI18n } from "../utils/i18n";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// "Save and export" runs outside the bar, so it reads the holds on its own: a number drawn out of
// range stops it, instead of the save sending the stored value back and exporting without the edit.
test("a drawn number out of range stops Save and export, and nothing is written", async () => {
  const stub = stubEditorApi({
    settings: { debounce: { enabled: true, windowSeconds: 15 } },
  });
  await renderEditor(stub, "behavior");
  fireEvent.change(screen.getByRole("spinbutton", { name: /Wait window/ }), {
    target: { value: "-10" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Save and export" }),
  );
  await waitFor(() =>
    expect(screen.getAllByText(/outside its range/).length).toBeGreaterThan(0),
  );
  expect(stub.writes.filter((w) => w.method !== "GET").length).toBe(0);
});

// A tab not on screen holds nothing live, so the hold it reported when it was drawn is what stops
// the export: the draft would otherwise go back as stored and the file carry the old value.
test("a number left out of range on another tab stops Save and export there", async () => {
  const stub = stubEditorApi({
    settings: { debounce: { enabled: true, windowSeconds: 15 } },
  });
  await renderEditor(stub, "behavior");
  fireEvent.change(screen.getByRole("spinbutton", { name: /Wait window/ }), {
    target: { value: "-10" },
  });
  fireEvent.click(screen.getByRole("tab", { name: /General/ }));
  await waitFor(() =>
    expect(
      screen.queryByRole("spinbutton", { name: /Wait window/ }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Save and export" }),
  );
  await waitFor(() =>
    expect(
      screen.getAllByText(/cannot be saved as it is/).length,
    ).toBeGreaterThan(0),
  );
  expect(stub.writes.filter((w) => w.method !== "GET").length).toBe(0);
});

const goTo = async (tab: string) => {
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  await screen.findByRole("tab", { name: tab, selected: true });
};

// The bar's Save, pressed on General, reopens Behavior to judge it again. The fields there report in
// the same render that resumes the save, before the tab's bar does, and the hold must already count.
test("the bar's Save from another tab stops on a number left out of range", async () => {
  const stub = stubEditorApi({
    settings: { debounce: { enabled: true, windowSeconds: 15 } },
  });
  await renderEditor(stub, "behavior");
  fireEvent.change(screen.getByRole("spinbutton", { name: /Wait window/ }), {
    target: { value: "-10" },
  });
  await goTo("General");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("tab", { name: "Behavior", selected: true });
  await waitFor(() =>
    expect(
      screen.getAllByText(/cannot be saved as it is/).length,
    ).toBeGreaterThan(0),
  );
  expect(stub.writes.filter((w) => w.method !== "GET").length).toBe(0);
  expect(
    (
      screen.getByRole("spinbutton", {
        name: /Wait window/,
      }) as HTMLInputElement
    ).value,
  ).toBe("-10");
});

// A legacy number stored out of range is not the save's business when its section is untouched.
test("an untouched out-of-range number on screen does not stop Save and export of another tab", async () => {
  const stub = stubEditorApi({
    name: "Atendente",
    settings: { debounce: { enabled: true, windowSeconds: -10 } },
  });
  await renderEditor(stub, "general");
  fireEvent.change(screen.getByLabelText(/^Name/), {
    target: { value: "Atendente 2" },
  });
  await goTo("Behavior");
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Save and export" }),
  );
  await waitFor(() => expect(stub.agent.name).toBe("Atendente 2"));
  expect(screen.queryAllByText(/outside its range\. Fix it/).length).toBe(0);
});

// A step stored with a unit and no value loads with the reader's default for that unit, so an
// untouched step does not show (and hold Save on) a value the runtime never reads.
test("a step with a unit and no value loads at the unit's ceiling, as the reader reads it", () => {
  expect(stepsToForm([{ delayUnit: "days" }])[0]?.delayValue).toBe("30");
  expect(stepsToForm([{ delayUnit: "minutes" }])[0]?.delayValue).toBe("60");
});

// A tab's own rule may be judged against another tab's draft, so only the number half of its hold is
// trusted once it is off screen: the bar reports the two apart.
test("a tab's bar reports its own rule and its numbers apart", () => {
  const calls: [boolean, boolean][] = [];
  const bar: EditorBar = {
    dirty: true,
    saving: false,
    onSave: () => {},
    onDiscard: () => {},
    sectionDirty: true,
    reportBlocked: (blocked, rangeHeld) => calls.push([blocked, rangeHeld]),
  };
  const draw = (value: string, saveDisabled: boolean) =>
    withI18n(
      <EditorBarContext.Provider value={bar}>
        <RangeHolds>
          <NumberInput
            aria-label="n"
            range={{ min: 1, max: 10, int: true }}
            value={value}
            onChange={() => {}}
          />
          <TabActionBar
            dirty
            saving={false}
            onSave={() => {}}
            onDiscard={() => {}}
            saveDisabled={saveDisabled}
          />
        </RangeHolds>
      </EditorBarContext.Provider>,
    );
  const view = render(draw("5", true));
  expect(calls.at(-1)).toEqual([true, false]);
  view.rerender(draw("50", false));
  expect(calls.at(-1)).toEqual([true, true]);
});

// Behavior's fallback had no endpoint to inherit under the stored provider, and General's draft gives
// it one. Off screen, Behavior's last verdict is stale; only its numbers still stand, and it has none
// out of range, so Save and export writes both.
test("a hold General's draft resolves on another tab does not stop Save and export", async () => {
  const stub = stubEditorApi({
    name: "Atendente",
    modelConfig: { provider: "openai", model: "gpt-4o-mini" },
    settings: {
      modelFallback: {
        provider: "openai-compatible",
        model: "m",
        baseURL: null,
      },
    },
  });
  await renderEditor(stub, "behavior");
  editTab("behavior");
  await goTo("General");
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: "openai-compatible" },
  });
  fireEvent.change(await screen.findByLabelText("Base URL"), {
    target: { value: "https://llm.example.com/v1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Save and export" }),
  );
  await waitFor(
    () =>
      expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(2),
    { timeout: 5_000 },
  );
  expect(screen.queryByText(/cannot be saved as it is/)).toBeNull();
});

// The number was out of range under the mode it was drawn in; switched to Monitoring, its section is
// not drawn. The cached verdict is not trusted under another mode: the tab is opened to judge again,
// and the next Save and export goes through with the hidden number kept as stored.
test("a range hold judged under another mode sends Save and export back to its tab", async () => {
  const stub = stubEditorApi({
    settings: { debounce: { enabled: true, windowSeconds: 15 } },
  });
  await renderEditor(stub, "behavior");
  fireEvent.change(screen.getByRole("spinbutton", { name: /Wait window/ }), {
    target: { value: "-10" },
  });
  await goTo("General");
  fireEvent.click(screen.getByRole("radio", { name: /^Monitoring/ }));
  const exportOnce = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save and export" }),
    );
  };
  await exportOnce();
  await screen.findByText(/mode changed since you left the Behavior tab/);
  await screen.findByRole("tab", { name: "Behavior", selected: true });
  expect(stub.writes.filter((w) => w.method !== "GET").length).toBe(0);
  await exportOnce();
  await waitFor(
    () =>
      // General's mode, then Behavior with the hidden number as stored.
      expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(2),
    { timeout: 5_000 },
  );
  expect(screen.queryByText(/cannot be saved as it is/)).toBeNull();
}, 15_000);

// A verdict that was clear under one mode is not trusted under another either: hidden in Monitoring
// the number reported nothing, and back in Production it is drawn again, out of range.
test("a clear verdict judged under another mode is judged again too", async () => {
  const stub = stubEditorApi({
    settings: { debounce: { enabled: true, windowSeconds: 15 } },
  });
  await renderEditor(stub, "behavior");
  fireEvent.change(screen.getByRole("spinbutton", { name: /Wait window/ }), {
    target: { value: "-10" },
  });
  await goTo("General");
  fireEvent.click(screen.getByRole("radio", { name: /^Monitoring/ }));
  await goTo("Behavior");
  await goTo("General");
  fireEvent.click(screen.getByRole("radio", { name: /^Production/ }));
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Save and export" }),
  );
  await screen.findByText(/mode changed since you left the Behavior tab/);
  await screen.findByRole("tab", { name: "Behavior", selected: true });
  expect(stub.writes.filter((w) => w.method !== "GET").length).toBe(0);
}, 15_000);
