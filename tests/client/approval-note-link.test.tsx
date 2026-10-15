/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "@/client/components/Markdown";
import { markdownLink } from "@/modules/documents/markdown-link";

// The approval note's link, rendered by the same Markdown component the console uses for a private
// note: an address with parentheses or backslashes stays one link that opens what was typed.

afterEach(() => cleanup());

test("an address with parentheses, a backslash or an entity-like query renders as one link to that address", () => {
  for (const url of [
    "https://app.example.com/docs?f=(open)&approval=42",
    "https://app.example.com/review/42\\",
    "https://app.example.com/a\\)b/42",
    "https://app.example.com/docs?approval=42&copy;=1",
  ]) {
    render(
      <Markdown>{`Pedido aberto.\n\n${markdownLink("Ver aprovação", url)}`}</Markdown>,
    );
    const link = screen.getByRole("link", { name: "Ver aprovação" });
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toBe(url);
    cleanup();
  }
});
