/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntegrationTypeCards } from "@/client/pages/resources/IntegrationEditModal";

// The kind of a new integration decides which configuration appears below it, so it is a choice of
// cards with a line each (agents#1254), from the same component as the agent's Mode. Assertions
// reduce to strings, numbers and booleans before expect.

afterEach(cleanup);

const CATALOG = [
  "GENERIC",
  "ASAAS",
  "GOOGLE_CALENDAR",
  "GOOGLE_DRIVE",
  "RESEND",
].map((catalogType) => ({ catalogType, label: catalogType, description: "" }));

describe("the integration kind is a group of cards", () => {
  test("one radio per catalog entry, the current one checked, each with its line", () => {
    const picked: string[] = [];
    render(
      <IntegrationTypeCards
        catalog={CATALOG}
        value="ASAAS"
        onPick={(c) => picked.push(c.catalogType)}
      />,
    );
    const g = screen.getByRole("radiogroup", { name: "Integration" });
    expect(g.hasAttribute("data-choice-cards")).toBe(true);
    const inputs = [
      ...g.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    expect(inputs.length).toBe(5);
    expect(inputs.filter((i) => i.checked).length).toBe(1);
    const label = (i: HTMLInputElement) =>
      (i.closest("label")?.textContent ?? "").trim();
    expect(label(inputs.find((i) => i.checked) as HTMLInputElement)).toContain(
      "Asaas",
    );
    // Every card has a line under the name, not only the name.
    for (const i of inputs) {
      const lines = i
        .closest("label")
        ?.querySelectorAll("[data-choice-hint]").length;
      expect(lines).toBe(1);
    }
    fireEvent.click(inputs[4] as HTMLInputElement);
    expect(picked.join(",")).toBe("RESEND");
  });
});
