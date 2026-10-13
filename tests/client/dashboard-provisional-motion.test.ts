import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The provisional pulse holds still under reduced motion, and every card runs the same animation with
// no delay of its own beyond the shared clock, so the page does not flicker out of step.
const css = readFileSync(`${import.meta.dir}/../../public/index.css`, "utf8");

describe("the provisional pulse", () => {
  test("is a slow opacity cycle between 0.55 and 0.85", () => {
    const frames = css.match(
      /@keyframes provisional-pulse \{[\s\S]*?\n\}/,
    )?.[0];
    expect(frames).toContain("opacity: 0.55");
    expect(frames).toContain("opacity: 0.85");
    expect(css).toMatch(
      /\.provisional-pulse \{\s*animation: provisional-pulse 1\.6s ease-in-out infinite;/,
    );
  });

  test("does not run under reduced motion", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.provisional-pulse \{\s*animation: none !important;/,
    );
  });
});
