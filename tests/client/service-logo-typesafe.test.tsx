import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { secretTypeService } from "@/client/lib/secretTypes";

// A TypeSafe entry is told apart from the other keys of the vault by its own mark: with only the
// generic key glyph, a vault holding several generic keys says nothing about which one the
// classifier uses.
describe("the TypeSafe credential's logo", () => {
  test("the typesafe kind names its service, and the service draws its own mark", () => {
    expect(secretTypeService("typesafe")).toBe("typesafe");
    const typesafe = renderToStaticMarkup(<ServiceLogo service="typesafe" />);
    const fallback = renderToStaticMarkup(<ServiceLogo service="no-such" />);
    expect(typesafe).toContain("<path");
    expect(typesafe).not.toBe(fallback);
  });
});
