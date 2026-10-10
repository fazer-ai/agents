/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { createTestI18n, withI18n } from "../utils/i18n";

// A `t()` default is not the English text. `i18next-parser` writes a default into the catalog the
// first time it sees a key and never overwrites it, so editing the literal changes nothing a user
// reads (docs/i18n.md, "Extract DELETES keys"). Asked of what the screens show: the code tool's
// editor and test dialog are rendered once from the English catalog and once from the defaults
// alone, and the two must read the same.

const { CodeToolEditModal } = await import(
  "@/client/pages/resources/CodeToolEditModal"
);
const { ToastProvider, useModalController } = await import(
  "@/client/components"
);

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const TOOL = {
  id: "1",
  name: "lookup_cpf",
  label: "Look up CPF",
  description: "Check whether a CPF is valid.",
  inputSchema: { cpf: { type: "string", required: true } },
  code: "return { by: context.agent_name, to: context.contact_name, cpf: input.cpf };",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function serveTool() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ tool: TOOL }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

function Harness() {
  const modal = useModalController<{ id?: string }>();
  return (
    <ToastProvider>
      <button type="button" onClick={() => modal.open({})}>
        open-new
      </button>
      <button type="button" onClick={() => modal.open({ id: "1" })}>
        open-1
      </button>
      <CodeToolEditModal modal={modal} />
    </ToastProvider>
  );
}

// Everything a reader meets: the text, what the fields hold, and the words carried by attributes.
function shown(): string[] {
  const out = [document.body.textContent ?? ""];
  for (const el of document.body.querySelectorAll("input, textarea")) {
    out.push(`value: ${(el as HTMLInputElement).value}`);
  }
  for (const el of document.body.querySelectorAll(
    "[placeholder], [aria-label], [aria-description]",
  )) {
    for (const a of ["placeholder", "aria-label", "aria-description"]) {
      const v = el.getAttribute(a);
      if (v) out.push(`${a}: ${v}`);
    }
  }
  return out;
}

// The three screens, in order: a new tool, a stored tool, and its test dialog.
async function screens(instance: I18n): Promise<string[][]> {
  serveTool();
  render(withI18n(<Harness />, instance));
  const seen: string[][] = [];
  fireEvent.click(screen.getByText("open-new"));
  await waitFor(() =>
    expect(document.body.querySelector(".cm-editor")).not.toBeNull(),
  );
  seen.push(shown());
  cleanup();
  render(withI18n(<Harness />, instance));
  fireEvent.click(screen.getByText("open-1"));
  await screen.findByDisplayValue("Look up CPF");
  seen.push(shown());
  fireEvent.click(
    screen.getByRole("button", {
      name: instance.t("codeTools.testOpen", "Test"),
    }),
  );
  await waitFor(() =>
    expect(document.body.querySelectorAll("[role=dialog]").length).toBe(2),
  );
  seen.push(shown());
  return seen;
}

function codeToolKeys(catalog: Record<string, unknown>): string[] {
  const block = catalog.codeTools as Record<string, unknown>;
  return Object.keys(block).sort();
}

describe("the code tool screens say what the source says", () => {
  test("the English catalog and the source defaults render the same screens", async () => {
    const fromCatalog = await screens(
      createTestI18n("en", {
        en: { translation: en },
        "pt-BR": { translation: {} },
      }),
    );
    cleanup();
    const fromDefaults = await screens(createTestI18n("en"));
    expect(fromCatalog).toEqual(fromDefaults);
  });

  // `keepRemoved: false` means a key pt-BR never got is answered in English, which reads as a
  // rendering choice rather than a gap.
  test("pt-BR carries every codeTools key English has", () => {
    const missing = codeToolKeys(en).filter(
      (k) => !codeToolKeys(ptBR).includes(k),
    );
    expect(codeToolKeys(en).length).toBeGreaterThan(15);
    expect(missing).toEqual([]);
  });
});
