import { beforeEach, describe, expect, test } from "bun:test";
import { applyFavicon } from "@/client/lib/favicon";
import {
  BRANDING_CACHE_KEY,
  BRANDING_DEFAULT_FAVICONS_KEY,
  brandingAssetUrl,
  pickVariant,
} from "@/lib/branding";

// The browser requests the icon declared in `<head>`, and `applyFavicon` cannot swap the links
// until the deferred module script has mounted. Measured in Chromium: leaving the declared links
// in place and appending a custom one makes the browser fetch BOTH, so the only shape that keeps
// the vendor's icon off the wire is removing them before the parser is done (#290).
//
// Removing them takes the declared defaults with it, and those are what a cleared favicon has to
// restore. So the inline script hands them over, and this file exercises both ends of that
// handover against the bytes the page actually ships.

const INDEX_HTML = await Bun.file(
  new URL("../../public/index.html", import.meta.url),
).text();

function parseIndex(): Document {
  return new DOMParser().parseFromString(INDEX_HTML, "text/html");
}

function iconLinks(): { href: string | null; media: string | null }[] {
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
  ).map((l) => ({
    href: l.getAttribute("href"),
    media: l.getAttribute("media"),
  }));
}

// Reproduce what the parser does to `document`: put the declared icon links in the head, then run
// each inline <head> script in document order. `new Function` evaluates in global scope, which is
// where happy-dom put `document`, `localStorage` and `matchMedia`.
function parseHead(): void {
  const parsed = parseIndex();
  for (const l of Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
  )) {
    l.remove();
  }
  for (const l of parsed.querySelectorAll('link[rel~="icon"]')) {
    document.head.appendChild(l.cloneNode(true));
  }
  for (const script of parsed.querySelectorAll("head script:not([src])")) {
    new Function(script.textContent ?? "")();
  }
}

const DECLARED = [
  { href: "./favicon-light.png", media: "(prefers-color-scheme: light)" },
  { href: "./favicon-dark.png", media: "(prefers-color-scheme: dark)" },
];

const CACHED = { version: "v7", logo: { dark: false, light: false } };

// One table, two implementations of the same rule: `pickVariant`, which the provider calls after
// mount, and the inline script that has to agree with it before mount.
const CASES: {
  name: string;
  present: { dark: boolean; light: boolean };
  theme: "dark" | "light";
  variant: "dark" | "light" | null;
}[] = [
  {
    name: "both variants on a dark theme",
    present: { dark: true, light: true },
    theme: "dark",
    variant: "dark",
  },
  {
    name: "both variants on a light theme",
    present: { dark: true, light: true },
    theme: "light",
    variant: "light",
  },
  {
    name: "only the light variant on a dark theme",
    present: { dark: false, light: true },
    theme: "dark",
    variant: "light",
  },
  {
    name: "only the dark variant on a light theme",
    present: { dark: true, light: false },
    theme: "light",
    variant: "dark",
  },
  {
    name: "no variant uploaded",
    present: { dark: false, light: false },
    theme: "dark",
    variant: null,
  },
];

describe("the tab icon on the first paint", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (globalThis as Record<string, unknown>)[
      BRANDING_DEFAULT_FAVICONS_KEY
    ];
    document.documentElement.removeAttribute("data-theme");
  });

  test("the declared icon links are the bundled defaults", () => {
    const declared = Array.from(
      parseIndex().querySelectorAll('link[rel~="icon"]'),
    ).map((l) => ({
      href: l.getAttribute("href"),
      media: l.getAttribute("media"),
    }));
    expect(declared).toEqual(DECLARED);
  });

  for (const { name, present, theme, variant } of CASES) {
    test(`${name} resolves to ${variant} after mount`, () => {
      expect(pickVariant(present, theme)).toBe(variant);
    });

    test(`${name} is already on the tab before mount`, () => {
      localStorage.setItem("@app:theme", theme);
      localStorage.setItem(
        BRANDING_CACHE_KEY,
        JSON.stringify({ ...CACHED, favicon: present }),
      );
      parseHead();
      expect(iconLinks()).toEqual(
        variant
          ? [
              {
                href: brandingAssetUrl("favicon", variant, CACHED.version),
                media: null,
              },
            ]
          : DECLARED,
      );
    });
  }

  // "auto" is the default preference and it is not a theme: only the attribute the theme script
  // stamps carries the resolved one. With the OS on dark the two answers differ, which is what
  // stops this script from reading `@app:theme` and picking the light icon for a dark page.
  test("an auto preference follows the theme the page resolved, not the string stored", () => {
    const realMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = ((q: string) => ({
      matches: q.includes("dark"),
    })) as typeof globalThis.matchMedia;
    try {
      localStorage.setItem("@app:theme", "auto");
      localStorage.setItem(
        BRANDING_CACHE_KEY,
        JSON.stringify({ ...CACHED, favicon: { dark: true, light: true } }),
      );
      parseHead();
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(iconLinks()).toEqual([
        {
          href: brandingAssetUrl("favicon", "dark", CACHED.version),
          media: null,
        },
      ]);
    } finally {
      globalThis.matchMedia = realMatchMedia;
    }
  });

  test("the declared links go with the script, not to the browser", () => {
    localStorage.setItem("@app:theme", "dark");
    localStorage.setItem(
      BRANDING_CACHE_KEY,
      JSON.stringify({ ...CACHED, favicon: { dark: true, light: true } }),
    );
    parseHead();
    expect(
      (globalThis as Record<string, unknown>)[BRANDING_DEFAULT_FAVICONS_KEY],
    ).toEqual(DECLARED);
  });

  test("clearing the favicon restores the links the script removed", () => {
    localStorage.setItem("@app:theme", "dark");
    localStorage.setItem(
      BRANDING_CACHE_KEY,
      JSON.stringify({ ...CACHED, favicon: { dark: true, light: true } }),
    );
    parseHead();
    applyFavicon(null);
    expect(iconLinks()).toEqual(DECLARED);
  });

  test("a favicon applied after mount does not become the default", () => {
    localStorage.setItem("@app:theme", "dark");
    localStorage.setItem(
      BRANDING_CACHE_KEY,
      JSON.stringify({ ...CACHED, favicon: { dark: true, light: true } }),
    );
    parseHead();
    applyFavicon(brandingAssetUrl("favicon", "light", "v8"));
    applyFavicon(null);
    expect(iconLinks()).toEqual(DECLARED);
  });

  test("with no script stash, the declared links are still what a clear restores", () => {
    parseHead();
    applyFavicon(brandingAssetUrl("favicon", "dark", "v7"));
    applyFavicon(null);
    expect(iconLinks()).toEqual(DECLARED);
  });

  test("a cold cache leaves the declared links alone", () => {
    parseHead();
    expect(iconLinks()).toEqual(DECLARED);
    expect(
      (globalThis as Record<string, unknown>)[BRANDING_DEFAULT_FAVICONS_KEY],
    ).toBeUndefined();
  });

  test("an unreadable cache is not fatal", () => {
    localStorage.setItem(BRANDING_CACHE_KEY, "{not json");
    expect(() => parseHead()).not.toThrow();
    expect(iconLinks()).toEqual(DECLARED);
  });

  test("a config with no favicon field at all leaves the declared links alone", () => {
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify({ version: "v7" }));
    parseHead();
    expect(iconLinks()).toEqual(DECLARED);
  });
});
