/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import {
  DEFAULT_DENSITY,
  DENSITY_STORAGE_KEY,
  DensityProvider,
  useDensity,
} from "@/client/contexts/DensityContext";

let hookValue: ReturnType<typeof useDensity> | null = null;

function Consumer() {
  hookValue = useDensity();
  return null;
}

function renderProvider() {
  return render(
    <DensityProvider>
      <Consumer />
    </DensityProvider>,
  );
}

describe("DensityContext", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.density;
    hookValue = null;
  });

  afterEach(() => {
    cleanup();
  });

  test("starts at the default and stamps it on <html>", () => {
    renderProvider();

    expect(hookValue?.density).toBe(DEFAULT_DENSITY);
    expect(document.documentElement.dataset.density).toBe(DEFAULT_DENSITY);
  });

  test("restores a stored preference", () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, "comfortable");
    renderProvider();

    expect(hookValue?.density).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });

  test("ignores a stored value it does not know", () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, "spacious");
    renderProvider();

    expect(hookValue?.density).toBe(DEFAULT_DENSITY);
  });

  test("setDensity updates <html> and persists", () => {
    renderProvider();

    act(() => hookValue?.setDensity("comfortable"));

    expect(hookValue?.density).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("comfortable");
  });

  test("the inline boot script falls back to the same default", async () => {
    const html = await Bun.file("public/index.html").text();
    const match = html.match(
      /density = density === "compact" \|\| density === "comfortable" \? density : "(\w+)"/,
    );

    expect(match?.[1]).toBe(DEFAULT_DENSITY);
  });
});
