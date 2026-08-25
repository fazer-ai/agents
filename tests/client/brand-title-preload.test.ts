import { beforeEach, describe, expect, test } from "bun:test";
import {
  BRANDING_CACHE_KEY,
  DEFAULT_BRAND_NAME,
  resolveBrandName,
} from "@/lib/branding";

// The browser stamps the tab title the moment `<title>` is parsed, and `BrandingProvider` cannot
// correct it until the deferred module script has been fetched, parsed and mounted. So the only
// place that can carry the operator's name onto the FIRST paint is an inline <head> script, and
// the only honest way to test one is to run the bytes the page ships (#277).

const INDEX_HTML = await Bun.file(
  new URL("../../public/index.html", import.meta.url),
).text();

function parseIndex(): Document {
  return new DOMParser().parseFromString(INDEX_HTML, "text/html");
}

// Reproduce what the parser does to `document`: apply the declared <title>, then run each inline
// <head> script in document order. `new Function` evaluates in global scope, which is where
// happy-dom put `document`, `localStorage` and `matchMedia`.
function parseHead(): void {
  const parsed = parseIndex();
  document.title = parsed.title;
  for (const script of parsed.querySelectorAll("head script:not([src])")) {
    new Function(script.textContent ?? "")();
  }
}

// One table, two implementations of the same rule: the pure resolver the provider uses after mount,
// and the inline script that has to agree with it before mount. The padded row is the one place the
// two agree for different reasons: the resolver trims, and the script lets the `document.title`
// getter strip and collapse the whitespace itself.
const CASES: { name: string; cached: unknown; title: string }[] = [
  {
    name: "a configured name",
    cached: { brandName: "Acme Co" },
    title: "Acme Co",
  },
  {
    name: "a padded name",
    cached: { brandName: "  Acme Co  " },
    title: "Acme Co",
  },
  {
    name: "a blank name",
    cached: { brandName: "   " },
    title: DEFAULT_BRAND_NAME,
  },
  {
    name: "a cleared name",
    cached: { brandName: null },
    title: DEFAULT_BRAND_NAME,
  },
  {
    name: "a config with no name at all",
    cached: {},
    title: DEFAULT_BRAND_NAME,
  },
];

describe("the tab title on the first paint", () => {
  beforeEach(() => {
    localStorage.clear();
    document.title = "";
  });

  test("the declared <title> is the product's own brand", () => {
    expect(parseIndex().title).toBe(DEFAULT_BRAND_NAME);
  });

  for (const { name, cached, title } of CASES) {
    test(`${name} resolves to "${title}" after mount`, () => {
      expect(resolveBrandName(cached as { brandName?: string | null })).toBe(
        title,
      );
    });

    test(`${name} is already on the tab before mount`, () => {
      localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(cached));
      parseHead();
      expect(document.title).toBe(title);
    });
  }

  test("a cold cache shows the product's own brand", () => {
    parseHead();
    expect(document.title).toBe(DEFAULT_BRAND_NAME);
  });

  test("an unreadable cache is not fatal", () => {
    localStorage.setItem(BRANDING_CACHE_KEY, "{not json");
    expect(() => parseHead()).not.toThrow();
    expect(document.title).toBe(DEFAULT_BRAND_NAME);
  });

  test("the cached name never reaches the DOM as markup", () => {
    localStorage.setItem(
      BRANDING_CACHE_KEY,
      JSON.stringify({ brandName: "<img src=x onerror=alert(1)>" }),
    );
    parseHead();
    expect(document.title).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });
});
