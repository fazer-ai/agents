/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Layout } from "@/client/components/Layout";
import { ToastProvider } from "@/client/components/Toast";
import { ApprovalsProvider } from "@/client/contexts/ApprovalsContext";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { BrandingProvider } from "@/client/contexts/BrandingContext";
import { SidebarProvider } from "@/client/contexts/SidebarContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { UpdatesProvider } from "@/client/contexts/UpdatesContext";
import { withI18n } from "../utils/i18n";

// The app shell scrolls in exactly ONE place, and the element that does it has to be POSITIONED.
// `sr-only` is `position: absolute`, so with a static scroller a screen-reader label deep in the
// content resolves against the document, stretches `documentElement.scrollHeight` past the viewport
// and adds an outer scrollbar that scrolls the header away; `overflow-y: auto` does not clip it.
// happy-dom computes no layout and Tailwind reaches no stylesheet here, so the rendered shell's
// classes are what is asked: whichever element carries the page-level scroll carries a positioning
// class beside it.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const POSITIONED = /\b(relative|absolute|fixed|sticky)\b/;
const PAGE_SCROLL = /\boverflow-(y-)?(auto|scroll)\b/;

async function renderShell(): Promise<Element[]> {
  // Every read the shell's providers make answers as missing, which each of them tolerates.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "not stubbed" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  render(
    withI18n(
      <MemoryRouter initialEntries={["/"]}>
        <ThemeProvider>
          <BrandingProvider>
            <ToastProvider>
              <TooltipPrimitive.Provider>
                <AuthProvider>
                  <SidebarProvider>
                    <ApprovalsProvider>
                      <UpdatesProvider>
                        <Layout>
                          <p>conteúdo da página</p>
                        </Layout>
                      </UpdatesProvider>
                    </ApprovalsProvider>
                  </SidebarProvider>
                </AuthProvider>
              </TooltipPrimitive.Provider>
            </ToastProvider>
          </BrandingProvider>
        </ThemeProvider>
      </MemoryRouter>,
    ),
  );
  const content = await screen.findByText("conteúdo da página");
  const chain: Element[] = [];
  for (let el = content.parentElement; el; el = el.parentElement) {
    chain.push(el);
  }
  return chain;
}

const classOf = (el: Element) => el.getAttribute("class") ?? "";

describe("the app shell contains its own scrolling", () => {
  test("the element that scrolls the page is positioned", async () => {
    const scrollers = (await renderShell())
      .map(classOf)
      .filter((c) => PAGE_SCROLL.test(c));
    // NOTE: none found means the page no longer scrolls inside the shell, and the check below
    // would pass over nothing.
    expect(scrollers.length).toBeGreaterThan(0);
    for (const cls of scrollers) expect(cls).toMatch(POSITIONED);
  });

  // The other half of the shape, and the reason the bug is invisible until something escapes: the
  // shell is pinned to the viewport, so anything that outgrows it can only show up as a second
  // scrollbar rather than as a longer page.
  test("the shell is pinned to the viewport and hides its own overflow", async () => {
    // Not `\bh-dvh\b`: a hyphen is a word boundary, so that also matches `min-h-dvh`, which sets
    // a FLOOR rather than a height and lets the shell grow past the viewport.
    const shell = (await renderShell())
      .map(classOf)
      .find((c) => /(?<![\w-])h-dvh(?![\w-])/.test(c));
    expect(shell).toBeDefined();
    expect(shell).toMatch(/\boverflow-hidden\b/);
  });
});
