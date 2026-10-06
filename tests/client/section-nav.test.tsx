/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Activity, Gauge, Tags } from "lucide-react";
import { Section, SectionNav } from "@/client/pages/agents/SectionNav";

// THE INDEX SAYS WHERE THE OPERATOR IS, the last section included. The scroll-spy marks the section
// that crosses the upper band of the viewport, and a last section shorter than the screen never gets
// there: the page ends first. At the bottom of its scroll container the last entry is the one
// highlighted, and an entry clicked stays highlighted where the scroll lands.

const realObserver = globalThis.IntersectionObserver;
let observed: IntersectionObserverCallback | null = null;

class FakeObserver {
  constructor(cb: IntersectionObserverCallback) {
    observed = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver =
  FakeObserver as unknown as typeof IntersectionObserver;

afterEach(() => {
  cleanup();
  observed = null;
});

afterAll(() => {
  globalThis.IntersectionObserver = realObserver;
});

const SECTIONS = [
  { id: "one", icon: Gauge, label: "One" },
  { id: "two", icon: Tags, label: "Two" },
  { id: "three", icon: Activity, label: "Three" },
];

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
  // happy-dom lays nothing out: the geometry a real scroll container would have is set by hand.
  Object.defineProperty(scroller, "clientHeight", { value: 800 });
  Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
  return { ...view, scroller };
}

const current = () =>
  screen
    .getAllByRole("link")
    .filter((a) => a.getAttribute("aria-current") === "true")
    .map((a) => a.textContent);

function crossing(id: string, isIntersecting: boolean) {
  const target = document.getElementById(id) as Element;
  act(() => {
    observed?.(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

function scrollTo(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  act(() => {
    fireEvent.scroll(scroller);
  });
}

describe("the section index", () => {
  test("highlights the section crossing the upper band as the page scrolls", () => {
    const { scroller } = renderNav();
    expect(current()).toEqual(["One"]);
    crossing("one", false);
    crossing("two", true);
    scrollTo(scroller, 600);
    expect(current()).toEqual(["Two"]);
  });

  test("at the bottom of the page the last section is highlighted, though it never reached the band", () => {
    const { scroller } = renderNav();
    crossing("two", true);
    scrollTo(scroller, 1200);
    expect(current()).toEqual(["Three"]);
    // Scrolling back up leaves the bottom, and the band decides again.
    scrollTo(scroller, 900);
    crossing("two", true);
    expect(current()).toEqual(["Two"]);
  });

  test("an entry clicked stays highlighted where its scroll lands", () => {
    const { scroller } = renderNav();
    const target = document.getElementById("two") as HTMLElement;
    target.scrollIntoView = () => {
      // The smooth scroll runs to the bottom: the clicked section is too low to reach the band, and
      // the sections it passes cross the band on the way.
      crossing("three", true);
      scrollTo(scroller, 1200);
    };
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: "Two" }));
    });
    expect(current()).toEqual(["Two"]);
  });

  test("after a click, the next scroll of the operator gives the highlight back to the band", async () => {
    const { scroller } = renderNav();
    const target = document.getElementById("two") as HTMLElement;
    target.scrollIntoView = () => scrollTo(scroller, 1200);
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: "Two" }));
    });
    // The smooth scroll has stopped; the operator scrolls up on their own.
    await act(() => new Promise((r) => setTimeout(r, 250)));
    crossing("one", true);
    scrollTo(scroller, 100);
    expect(current()).toEqual(["One"]);
  });

  // The section is already where the click would scroll it, so no scroll event comes: the hold has
  // to end on its own clock, or the operator's next scroll would be read as the click's.
  test("a click that scrolls nothing still gives the highlight back on the next scroll", async () => {
    const { scroller } = renderNav();
    const target = document.getElementById("two") as HTMLElement;
    target.scrollIntoView = () => {};
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: "Two" }));
    });
    expect(current()).toEqual(["Two"]);
    await act(() => new Promise((r) => setTimeout(r, 250)));
    crossing("one", true);
    scrollTo(scroller, 100);
    expect(current()).toEqual(["One"]);
  });

  test("a box scrolling to its end inside a section is not the page reaching its bottom", () => {
    renderNav();
    crossing("one", true);
    const box = document.createElement("textarea");
    document.getElementById("one")?.appendChild(box);
    Object.defineProperty(box, "clientHeight", { value: 100 });
    Object.defineProperty(box, "scrollHeight", { value: 300 });
    scrollTo(box, 200);
    expect(current()).toEqual(["One"]);
  });
});
