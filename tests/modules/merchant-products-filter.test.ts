import { describe, expect, test } from "bun:test";
import { matchesProductFilter } from "@/modules/merchant/products";

// `GET /merchant/products?q=&category=&tags=a,b&priceMax=` applies the
// structured filters BEFORE the text match: category/price narrow the SQL
// where, then this predicate applies the tag AND-match and the normalized
// free-text match over that set. These tests pin the semantics an agent tool
// relies on when it filters the catalog.

const serum = {
  name: "Serum trị mụn BHA 2%",
  description: "Serum cho da dầu mụn",
  tags: ["serum", "Trị mụn", "BHA"],
};
const dress = {
  name: "Váy suông tay phồng",
  description: "Váy nữ dáng suông",
  tags: ["váy", "thời trang nữ"],
};
const snack = {
  name: "Hạt điều rang muối 500g",
  description: null,
  tags: ["hạt điều", "snack"],
};

describe("matchesProductFilter tags (AND semantics)", () => {
  test("a product must carry EVERY listed tag", () => {
    expect(matchesProductFilter(serum, { tags: ["serum", "bha"] })).toBe(true);
    expect(matchesProductFilter(serum, { tags: ["serum", "váy"] })).toBe(false);
    expect(matchesProductFilter(dress, { tags: ["serum"] })).toBe(false);
  });

  test("tag match is diacritics- and case-insensitive", () => {
    // "tri mun" must find "Trị mụn" — the same normalization the scorer gives posts.
    expect(matchesProductFilter(serum, { tags: ["tri mun"] })).toBe(true);
    expect(matchesProductFilter(serum, { tags: ["BHA"] })).toBe(true);
  });

  test("empty tag list filters nothing", () => {
    expect(matchesProductFilter(serum, { tags: [] })).toBe(true);
    expect(matchesProductFilter(snack, {})).toBe(true);
  });
});

describe("matchesProductFilter q (text, applied last)", () => {
  test("matches name/description/tags, diacritics-insensitive", () => {
    // "serum tri mun" typed without accents still finds the product.
    expect(matchesProductFilter(serum, { q: "tri mun" })).toBe(true);
    expect(matchesProductFilter(dress, { q: "vay suong" })).toBe(true);
    expect(matchesProductFilter(snack, { q: "hat dieu" })).toBe(true);
    expect(matchesProductFilter(serum, { q: "váy" })).toBe(false);
  });

  test("q reaches tags too (a tag is text the customer would type)", () => {
    expect(matchesProductFilter(snack, { q: "snack" })).toBe(true);
  });
});

describe("structured-before-text precedence", () => {
  test("a row matching q alone is still dropped when tags don't match", () => {
    // "serum" IS in the name/tags, but the demanded tag is absent: the
    // structured filter decides first, the text match never rescues it.
    expect(matchesProductFilter(serum, { tags: ["váy"], q: "serum" })).toBe(
      false,
    );
    expect(matchesProductFilter(dress, { tags: ["váy"], q: "phồng" })).toBe(
      true,
    );
  });
});
