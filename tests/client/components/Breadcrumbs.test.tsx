/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Breadcrumbs } from "@/client/components/Breadcrumbs";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumbs />
    </MemoryRouter>,
  );
}

describe("Breadcrumbs", () => {
  afterEach(() => cleanup());

  test("renders nothing on root", () => {
    const { container } = renderAt("/");
    expect(container.firstChild).toBeNull();
  });

  test("links parent crumbs and marks the last as current", () => {
    renderAt("/settings/profile");
    const parent = screen.getByRole("link", { name: /settings/i });
    expect(parent).toHaveAttribute("href", "/settings");
    expect(screen.getByText(/profile/i)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
