/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "@/client/components/Markdown";

// A link into the console itself (the approval link a private note ends on) opens in place; any
// other link opens in a new tab, away from the console.

afterEach(() => cleanup());

test("a console link opens in place, any other in a new tab", () => {
  const origin = window.location.origin;
  render(
    <Markdown>
      {`[Ver aprovação](${origin}/document-approvals/7?switchTenant=1) e [site](https://example.com/x)`}
    </Markdown>,
  );
  const inside = screen.getByRole("link", { name: "Ver aprovação" });
  expect(inside.getAttribute("target")).toBeNull();
  const outside = screen.getByRole("link", { name: "site" });
  expect(outside.getAttribute("target")).toBe("_blank");
  expect(outside.getAttribute("rel")).toBe("noopener noreferrer");
});
