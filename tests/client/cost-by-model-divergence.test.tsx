/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import type { ComponentProps, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import { CostByModelCard } from "@/client/pages/dashboard/CostByModel";

// Issue #868: the "Cost by model" card marks a model whose local price-table cost diverges from
// Langfuse's, and the marker opens both figures and what to do. A model that agrees, or that the
// local table could not price in full, carries no marker: the card never claims a check it did not
// make, and never flags one it could not.

afterEach(cleanup);

async function inLanguage(lng: "en" | "pt-BR", ui: ReactNode) {
  const i = i18next.createInstance();
  await i.init({
    lng,
    resources: {
      en: { translation: clientEn },
      "pt-BR": { translation: clientPt },
    },
    interpolation: { escapeValue: false },
  });
  return render(<I18nextProvider i18n={i}>{ui}</I18nextProvider>);
}

type Props = ComponentProps<typeof CostByModelCard>;
type Check = NonNullable<Props["costCheck"]>;
type Comparison = Check["models"][number];

const byModel: Props["byModel"] = [
  { model: "gpt-4o-mini-2024-07-18", costUsd: 6 },
  { model: "claude-x", costUsd: 9 },
  { model: "agrees", costUsd: 5.5 },
];

function cmp(over: Partial<Comparison>): Comparison {
  return {
    model: "m",
    ledgerModels: [over.model ?? "m"],
    langfuseModels: ["m"],
    localUsd: 0,
    langfuseUsd: 0,
    calls: 1,
    localUnpricedCalls: 0,
    status: "match",
    ...over,
  };
}

const check: Check = {
  models: [
    cmp({
      model: "gpt-4o-mini",
      langfuseModels: ["gpt-4o-mini-2024-07-18"],
      localUsd: 3,
      langfuseUsd: 6,
      calls: 3,
      status: "diverges",
    }),
    cmp({
      model: "claude-x",
      langfuseModels: ["claude-x"],
      localUsd: 2,
      langfuseUsd: 9,
      calls: 2,
      localUnpricedCalls: 1,
      status: "incomplete",
    }),
    cmp({
      model: "agrees",
      langfuseModels: ["agrees"],
      localUsd: 5,
      langfuseUsd: 5.5,
      status: "match",
    }),
  ],
  onlyInLangfuse: ["unknown"],
  onlyLocal: ["local-only"],
};

function rowOf(model: string): HTMLElement {
  const li = screen.getByText(model).closest("li");
  if (!li) throw new Error(`no row for ${model}`);
  return li as HTMLElement;
}

describe("the cost check on the cost-by-model card", () => {
  test("only the diverging model carries the marker, and the card says how many diverge", async () => {
    await inLanguage(
      "en",
      <CostByModelCard byModel={byModel} costCheck={check} />,
    );
    const markers = screen.getAllByTestId("cost-divergence-marker");
    expect(markers).toHaveLength(1);
    expect(
      rowOf("gpt-4o-mini-2024-07-18").contains(markers[0] as HTMLElement),
    ).toBe(true);
    expect(screen.getByTestId("cost-divergence-summary").textContent).toBe(
      "1 model costs differently in Langfuse than in this app's price table",
    );
  });

  test("the popover gives both figures, the thresholds and what to do", async () => {
    await inLanguage(
      "en",
      <CostByModelCard byModel={byModel} costCheck={check} />,
    );
    fireEvent.click(screen.getByTestId("cost-divergence-marker"));
    const detail =
      screen.getByTestId("cost-divergence-detail").textContent ?? "";
    expect(detail).toContain("what gpt-4o-mini cost");
    expect(detail).toContain("Langfuse's figure$6.00");
    expect(detail).toContain("This app's figure$3.00");
    expect(detail).toContain("Langfuse names it gpt-4o-mini-2024-07-18.");
    expect(detail).toContain("more than 20% and by at least $1.00");
    expect(detail).toContain("vendor's own page");
    expect(detail).toContain("set this account's own price for the model");
    expect(detail).toContain("re-priced");
  });

  test("names one side has are listed apart, and never marked", async () => {
    await inLanguage(
      "en",
      <CostByModelCard byModel={byModel} costCheck={check} />,
    );
    expect(screen.getByTestId("cost-check-only-langfuse").textContent).toBe(
      "Only in Langfuse, not compared: unknown",
    );
    expect(screen.getByTestId("cost-check-only-local").textContent).toBe(
      "Only in this app's usage records, not compared: local-only",
    );
  });

  test("more than one diverging model is counted in the plural, in both languages", async () => {
    const two: Check = {
      ...check,
      models: check.models.map((m) =>
        m.model === "agrees" ? { ...m, status: "diverges" as const } : m,
      ),
    };
    await inLanguage(
      "en",
      <CostByModelCard byModel={byModel} costCheck={two} />,
    );
    expect(screen.getByTestId("cost-divergence-summary").textContent).toBe(
      "2 models cost differently in Langfuse than in this app's price table",
    );
    cleanup();
    await inLanguage(
      "pt-BR",
      <CostByModelCard byModel={byModel} costCheck={two} />,
    );
    expect(screen.getByTestId("cost-divergence-summary").textContent).toBe(
      "2 modelos custam diferente no Langfuse e na tabela de preços deste app",
    );
    cleanup();
    await inLanguage(
      "pt-BR",
      <CostByModelCard byModel={byModel} costCheck={check} />,
    );
    expect(screen.getByTestId("cost-divergence-summary").textContent).toBe(
      "1 modelo custa diferente no Langfuse e na tabela de preços deste app",
    );
  });

  test("with no check (the ledger could not be read), the card is the costs and nothing else", async () => {
    await inLanguage(
      "en",
      <CostByModelCard byModel={byModel} costCheck={undefined} />,
    );
    expect(screen.queryByTestId("cost-divergence-marker")).toBeNull();
    expect(screen.queryByTestId("cost-divergence-summary")).toBeNull();
    expect(screen.queryByTestId("cost-check-only-langfuse")).toBeNull();
    expect(screen.getByText("$6.00")).toBeTruthy();
  });

  test("nothing diverging, nothing said: no summary and no marker", async () => {
    const calm: Check = {
      models: check.models.filter((m) => m.status !== "diverges"),
      onlyInLangfuse: [],
      onlyLocal: [],
    };
    await inLanguage(
      "en",
      <CostByModelCard byModel={byModel} costCheck={calm} />,
    );
    expect(screen.queryByTestId("cost-divergence-marker")).toBeNull();
    expect(screen.queryByTestId("cost-divergence-summary")).toBeNull();
  });

  test("a group of ledger models is named in full in the popover, and said to be compared as a sum", async () => {
    const grouped: Check = {
      models: [
        cmp({
          model: "gpt-4o",
          ledgerModels: ["gpt-4o", "gpt-4o-2024-08-06"],
          langfuseModels: ["gpt-4o-2024-08-06"],
          localUsd: 20,
          langfuseUsd: 40,
          calls: 10,
          status: "diverges",
        }),
      ],
      onlyInLangfuse: [],
      onlyLocal: [],
    };
    await inLanguage(
      "en",
      <CostByModelCard
        byModel={[{ model: "gpt-4o-2024-08-06", costUsd: 40 }]}
        costCheck={grouped}
      />,
    );
    fireEvent.click(screen.getByTestId("cost-divergence-marker"));
    const detail =
      screen.getByTestId("cost-divergence-detail").textContent ?? "";
    expect(detail).toContain("what gpt-4o, gpt-4o-2024-08-06 cost");
    expect(detail).toContain(
      "Langfuse can report calls to gpt-4o, gpt-4o-2024-08-06 under one name, so they are compared together, as their sum.",
    );
    expect(detail).toContain("This app's figure$20.00");
    // The snapshot is one of the group's own names, so it is not a rename.
    expect(detail).not.toContain("Langfuse names it");
  });
});
