/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// The days field keeps its own text while it is typed, so a field left empty is not written into the
// form. A discard that puts back the same saved number has to clear that text too, or the field stays
// empty and keeps Save blocked after the discard.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const daysField = () =>
  screen.getByRole("spinbutton", { name: /Days to keep/ }) as HTMLInputElement;

test("a discard refills the days field an operator left empty", async () => {
  const stub = stubEditorApi({
    settings: {
      observability: { logToolValues: true, fullDetailRetentionDays: 14 },
    },
  });
  await renderEditor(stub, "behavior");
  await waitFor(() => expect(daysField().value).toBe("14"));
  fireEvent.change(daysField(), { target: { value: "" } });
  expect(daysField().value).toBe("");
  // Clearing the field alone writes nothing into the form, so the editor may not call it unsaved;
  // an edit elsewhere makes the discard available.
  fireEvent.click(
    screen.getByRole("switch", { name: /Log the values sent to tools/ }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
  await waitFor(() => expect(daysField().value).toBe("14"));
}, 30_000);
