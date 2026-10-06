/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Activity, Gauge, Tags } from "lucide-react";
import { Section, SectionNav } from "@/client/pages/agents/SectionNav";

// THE INDEX SAYS WHERE THE OPERATOR IS. The current section is the one whose top has passed a line
// at 35% of the scroll container, so a tall section above does not keep the highlight from the one
// under it. The ends of the page decide on their own (the first section at the top, the last at the
// bottom, which a short last section never reaches the line for), and an entry clicked stays
// highlighted where its scroll lands until the operator takes the scroll back.

afterEach(() => {
  cleanup();
});

const SECTIONS = [
  { id: "one", icon: Gauge, label: "One" },
  { id: "two", icon: Tags, label: "Two" },
  { id: "three", icon: Activity, label: "Three" },
];

// happy-dom lays nothing out: the container is 800px tall from y=0, so the line sits at y=280, and
// each section's top is set by hand for the scroll position under test.
function renderNav() {
  const view = render(
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <SectionNav sections={SECTIONS} />
      {SECTIONS.map((s) => (
        <Section key={s.id} id={s.id} icon={s.icon} title={s.label}>
          <p>{s.label} body</p>
        </Section>
      ))}
    </div>,
  );
  const scroller = screen.getByTestId("scroller");
  Object.defineProperty(scroller, "clientHeight", { value: 800 });
  Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  return { ...view, scroller };
}

function place(tops: Record<string, number>) {
  for (const [id, top] of Object.entries(tops)) {
    const el = document.getElementById(id) as HTMLElement;
    el.getBoundingClientRect = () => ({ top, height: 300 }) as DOMRect;
  }
}

function scrollTo(
  scroller: HTMLElement,
  top: number,
  tops: Record<string, number> = {},
) {
  place(tops);
  scroller.scrollTop = top;
  act(() => {
    fireEvent.scroll(scroller);
  });
}

const current = () =>
  screen
    .getAllByRole("link")
    .filter((a) => a.getAttribute("aria-current") === "true")
    .map((a) => a.textContent);

function clickEntry(name: string, scroll: () => void) {
  const target = document.getElementById(name.toLowerCase()) as HTMLElement;
  target.scrollIntoView = scroll;
  act(() => {
    fireEvent.click(screen.getByRole("link", { name }));
  });
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 250)));

describe("the section index", () => {
  test("highlights the section whose top has passed the line", () => {
    const { scroller } = renderNav();
    expect(current()).toEqual(["One"]);
    scrollTo(scroller, 600, { one: -500, two: 100, three: 900 });
    expect(current()).toEqual(["Two"]);
    scrollTo(scroller, 400, { one: -300, two: 300, three: 1100 });
    expect(current()).toEqual(["One"]);
  });

  // The defect the band had: a tall section still covering the upper part of the screen kept the
  // highlight from the one whose top was already well inside it.
  test("a tall section above does not keep the highlight from the one under it", () => {
    const { scroller } = renderNav();
    scrollTo(scroller, 900, { one: -900, two: 250, three: 1200 });
    expect(current()).toEqual(["Two"]);
  });

  // The app scrolls <main>, which starts below the header: the line is measured from the
  // container's own top, not the viewport's.
  test("the line sits 35% down the scroll container, wherever the container starts", () => {
    const { scroller } = renderNav();
    scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    // The line is at 100 + 280 = 380: a section whose top is at 350 has passed it.
    scrollTo(scroller, 600, { one: -500, two: 350, three: 900 });
    expect(current()).toEqual(["Two"]);
    // At 400 it has not.
    scrollTo(scroller, 550, { one: -450, two: 400, three: 950 });
    expect(current()).toEqual(["One"]);
  });

  test("at the top of the page the first section is highlighted, though a short one leaves the line in the next", () => {
    const { scroller } = renderNav();
    scrollTo(scroller, 600, { one: -500, two: 100, three: 900 });
    scrollTo(scroller, 0, { one: 0, two: 150, three: 900 });
    expect(current()).toEqual(["One"]);
  });

  test("at the bottom of the page the last section is highlighted, though it never reached the line", () => {
    const { scroller } = renderNav();
    scrollTo(scroller, 1200, { one: -1100, two: 100, three: 500 });
    expect(current()).toEqual(["Three"]);
    // Scrolling back up leaves the bottom, and the line decides again.
    scrollTo(scroller, 900, { one: -800, two: 200, three: 800 });
    expect(current()).toEqual(["Two"]);
  });

  test("an entry clicked stays highlighted where its scroll lands", () => {
    const { scroller } = renderNav();
    // The smooth scroll runs to the bottom: the clicked section stops too low for the line.
    clickEntry("Two", () =>
      scrollTo(scroller, 1200, { one: -1100, two: 400, three: 900 }),
    );
    expect(current()).toEqual(["Two"]);
  });

  test("after a click, the next scroll of the operator gives the highlight back to the line", async () => {
    const { scroller } = renderNav();
    clickEntry("Two", () =>
      scrollTo(scroller, 1200, { one: -1100, two: 400, three: 900 }),
    );
    await settle();
    scrollTo(scroller, 100, { one: -50, two: 500, three: 1100 });
    expect(current()).toEqual(["One"]);
  });

  // The section is already where the click would scroll it, so no scroll event comes: the hold has
  // to end on its own clock, or the operator's next scroll would be read as the click's.
  test("a click that scrolls nothing still gives the highlight back on the next scroll", async () => {
    const { scroller } = renderNav();
    clickEntry("Two", () => {});
    expect(current()).toEqual(["Two"]);
    await settle();
    scrollTo(scroller, 100, { one: -50, two: 500, three: 1100 });
    expect(current()).toEqual(["One"]);
  });

  // The operator taking over mid-animation ends the hold at once: their scroll events arrive back to
  // back with the animation's, so waiting for the scroll to settle would hold through the whole gesture.
  for (const gesture of ["wheel", "touchstart", "keydown"] as const) {
    test(`a ${gesture} during the click's scroll gives the highlight back immediately`, () => {
      const { scroller } = renderNav();
      clickEntry("Two", () =>
        scrollTo(scroller, 900, { one: -800, two: 200, three: 800 }),
      );
      expect(current()).toEqual(["Two"]);
      act(() => {
        if (gesture === "keydown")
          fireEvent.keyDown(scroller, { key: "PageUp" });
        else if (gesture === "touchstart") fireEvent.touchStart(scroller);
        else fireEvent.wheel(scroller);
      });
      scrollTo(scroller, 100, { one: -50, two: 500, three: 1100 });
      expect(current()).toEqual(["One"]);
    });
  }

  test("a box scrolling to its end inside a section is not the page reaching its bottom", () => {
    renderNav();
    const box = document.createElement("textarea");
    document.getElementById("one")?.appendChild(box);
    Object.defineProperty(box, "clientHeight", { value: 100 });
    Object.defineProperty(box, "scrollHeight", { value: 300 });
    scrollTo(box, 200);
    expect(current()).toEqual(["One"]);
  });
});
