import { describe, expect, test } from "bun:test";
import { isValidSlug, slugify } from "@/client/lib/utils";

describe("slugify", () => {
  test("lowercases and hyphenates spaces", () => {
    expect(slugify("Acme Co")).toBe("acme-co");
  });

  test("strips PT-BR diacritics (NFD)", () => {
    expect(slugify("Ação Atenção")).toBe("acao-atencao");
    expect(slugify("São Paulo")).toBe("sao-paulo");
  });

  test("collapses runs of special characters into a single hyphen", () => {
    expect(slugify("a -- b__c!!d")).toBe("a-b-c-d");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugify("  --Hello, World!--  ")).toBe("hello-world");
  });

  test("returns empty string when there are no alphanumerics", () => {
    expect(slugify("!!! ??? ---")).toBe("");
  });

  test("output always satisfies the slug pattern (when non-empty)", () => {
    for (const [input, expected] of [
      ["Açaí & Cia", "acai-cia"],
      ["  Foo   Bar  ", "foo-bar"],
      ["Über Café 42", "uber-cafe-42"],
    ] as const) {
      const slug = slugify(input);
      expect(slug).toBe(expected);
      expect(isValidSlug(slug)).toBe(true);
    }
  });
});

describe("isValidSlug", () => {
  test("accepts lowercase alphanumerics and internal single hyphens", () => {
    expect(isValidSlug("acme")).toBe(true);
    expect(isValidSlug("acme-co")).toBe(true);
    expect(isValidSlug("a1-b2-c3")).toBe(true);
  });

  test("rejects uppercase, spaces and other characters", () => {
    expect(isValidSlug("Acme")).toBe(false);
    expect(isValidSlug("acme co")).toBe(false);
    expect(isValidSlug("acme_co")).toBe(false);
    expect(isValidSlug("acme.co")).toBe(false);
  });

  test("rejects leading/trailing hyphens and empty input", () => {
    expect(isValidSlug("-acme")).toBe(false);
    expect(isValidSlug("acme-")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });
});
