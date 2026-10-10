/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { revealFirstProblem } from "@/client/pages/agents/saveAttempt";

// A Save pressed while something keeps the setup from being written is never a silent click
// (agents#1224): the page lights what is missing and takes the operator to the first problem on
// the tab, its field when the field is here, or the way to the other tab when it is not.

const scrolled: string[] = [];
const realScroll = HTMLElement.prototype.scrollIntoView;
beforeEach(() => {
  scrolled.length = 0;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.mark ?? this.tagName);
  };
});
afterEach(() => {
  cleanup();
  HTMLElement.prototype.scrollIntoView = realScroll;
});

const focusedMark = () =>
  (document.activeElement as HTMLElement | null)?.dataset.mark ?? "none";

describe("revealing the first problem", () => {
  test("goes to the first invalid field, past the summary at the top", () => {
    const { container } = render(
      <div>
        <div data-problems-summary role="alert" data-mark="summary">
          <button type="button" data-mark="summary-button">
            Open
          </button>
        </div>
        <input data-mark="ok" />
        <input aria-invalid="true" data-mark="bad" />
      </div>,
    );
    expect(revealFirstProblem(container)).toBe(true);
    expect(scrolled).toEqual(["bad"]);
    expect(focusedMark()).toBe("bad");
  });

  test("an error line under a control focuses that control", () => {
    const { container } = render(
      <div>
        <div>
          <select data-mark="rule-question">
            <option>x</option>
          </select>
          <span role="alert" data-mark="line">
            The question is gone.
          </span>
        </div>
      </div>,
    );
    expect(revealFirstProblem(container)).toBe(true);
    expect(scrolled).toEqual(["line"]);
    expect(focusedMark()).toBe("rule-question");
  });

  test("a control that draws its own warning is reached by its problem mark", () => {
    const { container } = render(
      <div>
        <div data-problems-summary role="alert" data-mark="summary">
          <button type="button">Open</button>
        </div>
        <div data-problem data-mark="key">
          <button type="button" data-mark="key-picker">
            None
          </button>
        </div>
      </div>,
    );
    expect(revealFirstProblem(container)).toBe(true);
    expect(scrolled).toEqual(["key"]);
    expect(focusedMark()).toBe("key-picker");
  });

  test("with nothing here to fix, the summary's way out takes the focus", () => {
    const { container } = render(
      <div>
        <div data-problems-summary role="alert" data-mark="summary">
          <button type="button" data-mark="summary-button">
            Open General
          </button>
        </div>
        <input data-mark="ok" />
      </div>,
    );
    expect(revealFirstProblem(container)).toBe(true);
    expect(scrolled).toEqual(["summary"]);
    expect(focusedMark()).toBe("summary-button");
  });

  test("says so when there is nothing to reveal", () => {
    const { container } = render(
      <div>
        <input data-mark="ok" />
      </div>,
    );
    expect(revealFirstProblem(container)).toBe(false);
    expect(revealFirstProblem(null)).toBe(false);
    expect(scrolled).toEqual([]);
  });
});
