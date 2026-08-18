/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Textarea } from "@/client/components/Textarea";

// The caps on operator prose are enforced where the operator cannot see them: the readers clamp on
// READ, so a note longer than its cap saved fine, hydrated back whole, and reached the model cut in
// half. `maxLength` stops new text at the wall; this counter is what tells someone who is already
// past it (typed before the cap existed, imported, or written through the API) why their rule is not
// all there.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.
const counterShown = (text: string) => screen.queryAllByText(text).length > 0;
// Either language: the suite does not pin the console's locale.
const overLimitShown = () =>
  screen.queryAllByText(/over the limit|acima do limite/i).length > 0;

describe("Textarea character counter", () => {
  afterEach(() => cleanup());

  test("stays quiet while the value is far from the cap", () => {
    render(
      <Textarea maxLength={100} value={"x".repeat(79)} onChange={() => {}} />,
    );
    expect(counterShown("79/100")).toBe(false);
    expect(overLimitShown()).toBe(false);
  });

  test("shows the count as the value approaches the cap", () => {
    render(
      <Textarea maxLength={100} value={"x".repeat(80)} onChange={() => {}} />,
    );
    expect(counterShown("80/100")).toBe(true);
    expect(overLimitShown()).toBe(false);
  });

  test("a value already past the cap says so, with the count", () => {
    render(
      <Textarea maxLength={100} value={"x".repeat(140)} onChange={() => {}} />,
    );
    expect(overLimitShown()).toBe(true);
    expect(counterShown("140/100")).toBe(true);
    // aria-invalid, so the state is not carried by colour alone.
    const el = screen.getByRole("textbox");
    expect(el.getAttribute("aria-invalid")).toBe("true");
  });

  // Raw length, the same thing the browser enforces `maxLength` against and the same thing the write
  // boundary refuses on. Counting the trimmed string instead put the control at odds with itself:
  // leading spaces made it stop accepting characters while the counter still showed room.
  test("whitespace counts, so the counter never disagrees with the control", () => {
    render(
      <Textarea
        maxLength={100}
        value={`  ${"x".repeat(100)}`}
        onChange={() => {}}
      />,
    );
    expect(overLimitShown()).toBe(true);
    expect(counterShown("102/100")).toBe(true);
  });

  test("no cap declared, no counter", () => {
    render(<Textarea value={"x".repeat(5000)} onChange={() => {}} />);
    expect(screen.queryAllByText(/\/\d+$/).length).toBe(0);
    expect(overLimitShown()).toBe(false);
  });

  test("an explicit errorMessage still wins over the counter's own message", () => {
    render(
      <Textarea
        maxLength={100}
        value={"x".repeat(140)}
        errorMessage="boom"
        onChange={() => {}}
      />,
    );
    expect(screen.queryAllByText("boom").length).toBe(1);
  });
});
