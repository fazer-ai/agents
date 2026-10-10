/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { ToolPreconditionsEditor } from "@/client/pages/agents/ToolPreconditionsEditor";

afterEach(cleanup);

describe("the Tools tab's wording", () => {
  test("the note under the native tools carries no dash, in either language", () => {
    for (const cat of [en, ptBR]) {
      expect(/[—–]/.test(cat.editor.tools.nativeContextNote)).toBe(false);
    }
  });

  // On questions and rules nobody is told why a tool was refused: the rule's action does not run and
  // the refusal is in the logs. The help says that, not what a model would hear.
  test("the preconditions' help says what happens on each engine", () => {
    render(
      <ToolPreconditionsEditor
        rows={[]}
        onChange={() => {}}
        grantedNativeTools={[]}
        decides
      />,
    );
    const decides = document.body.textContent ?? "";
    expect(decides.includes("is told why")).toBe(false);
    expect(decides.includes("does not run")).toBe(true);
    cleanup();
    render(
      <ToolPreconditionsEditor
        rows={[]}
        onChange={() => {}}
        grantedNativeTools={[]}
      />,
    );
    expect(screen.queryAllByText(/is told why/).length).toBeGreaterThan(0);
  });
});
