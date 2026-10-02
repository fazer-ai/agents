import { describe, expect, test } from "bun:test";
import {
  mergeTags,
  normalizeCategory,
  parseTaggingResponse,
} from "@/modules/merchant/tagging";

// The tagger writes tagSource="llm" only on a verified-JSON answer, so the
// parser is the security boundary of the whole feature: every answer shape the
// model can produce has to be decided here, or a chatty refusal would land in
// the catalog as if it were a classification.

describe("parseTaggingResponse", () => {
  test("accepts a bare JSON object with the declared shape", () => {
    const out = parseTaggingResponse(
      '{"category":"mỹ phẩm/skincare","tags":["serum","trị mụn"],"attributes":{"size":"30ml","priceSegment":"trung bình"}}',
    );
    expect(out).not.toBeNull();
    expect(out?.category).toBe("mỹ phẩm/skincare");
    expect(out?.tags).toEqual(["serum", "trị mụn"]);
    expect(out?.attributes).toEqual({
      size: "30ml",
      priceSegment: "trung bình",
    });
  });

  test("unwraps a ```json fenced answer", () => {
    const out = parseTaggingResponse(
      'Here is the classification:\n```json\n{"category":"thời trang nữ","tags":["váy"],"attributes":{"color":"đỏ"}}\n```',
    );
    expect(out?.category).toBe("thời trang nữ");
  });

  test("returns null on a prose refusal (no JSON at all)", () => {
    expect(
      parseTaggingResponse("Xin lỗi, tôi không thể phân loại sản phẩm này."),
    ).toBeNull();
  });

  test("returns null on truncated/invalid JSON", () => {
    expect(parseTaggingResponse('{"category":"khác","tags":["a')).toBeNull();
    expect(parseTaggingResponse("{not json}")).toBeNull();
  });

  test("returns null when required fields have the wrong type", () => {
    expect(
      parseTaggingResponse('{"category":42,"tags":[],"attributes":{}}'),
    ).toBeNull();
    expect(parseTaggingResponse('{"tags":["a"],"attributes":{}}')).toBeNull();
    // attributes must be a flat object, not an array of facets.
    expect(
      parseTaggingResponse(
        '{"category":"khác","tags":[],"attributes":["size","M"]}',
      ),
    ).toBeNull();
  });

  test("defaults tags/attributes when the model omits them", () => {
    const out = parseTaggingResponse('{"category":"khác"}');
    expect(out).not.toBeNull();
    expect(out?.tags).toEqual([]);
    expect(out?.attributes).toEqual({});
  });
});

describe("normalizeCategory", () => {
  test("maps accent/case variants onto the taxonomy node", () => {
    expect(normalizeCategory("Thời Trang Nữ")).toBe("thời trang nữ");
    expect(normalizeCategory("thoi trang nam")).toBe("thời trang nam");
    expect(normalizeCategory("Mỹ phẩm/Skincare")).toBe("mỹ phẩm/skincare");
  });

  test("falls back to khác for an off-taxonomy answer", () => {
    expect(normalizeCategory("đồ điện tử")).toBe("khác");
    expect(normalizeCategory("")).toBe("khác");
  });
});

describe("mergeTags", () => {
  test("unions LLM tags onto existing manual tags without dropping any", () => {
    expect(mergeTags(["manual-tag", "BHA"], ["serum", "bha"])).toEqual([
      "manual-tag",
      "BHA",
      "serum",
    ]);
  });

  test("dedupes on the normalized spelling, keeping the stored casing", () => {
    expect(mergeTags(["Trị mụn"], ["trị  mụn", "TRỊ MỤN"])).toEqual([
      "Trị mụn",
    ]);
  });

  test("ignores blank model tags", () => {
    expect(mergeTags(["a"], ["", "  "])).toEqual(["a"]);
  });
});
