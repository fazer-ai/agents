import { describe, expect, test } from "bun:test";
import { pickMarkAsset } from "@/lib/branding";

const none = { dark: false, light: false };

describe("the square symbol the collapsed sidebar shows", () => {
  test("the uploaded icon wins over the favicon", () => {
    expect(
      pickMarkAsset(
        {
          mark: { dark: true, light: true },
          favicon: { dark: true, light: true },
        },
        "light",
      ),
    ).toEqual({ kind: "mark", variant: "light" });
  });

  test("an icon stored for the other theme only still wins over the favicon", () => {
    expect(
      pickMarkAsset(
        {
          mark: { dark: true, light: false },
          favicon: { dark: true, light: true },
        },
        "light",
      ),
    ).toEqual({ kind: "mark", variant: "dark" });
  });

  test("without an icon, the favicon stands in", () => {
    expect(
      pickMarkAsset(
        { mark: none, favicon: { dark: false, light: true } },
        "dark",
      ),
    ).toEqual({ kind: "favicon", variant: "light" });
  });

  // A config cached by a console from before the icon existed carries no `mark` at all.
  test("a config with no icon field reads as no icon", () => {
    expect(
      pickMarkAsset({ favicon: { dark: true, light: false } }, "dark"),
    ).toEqual({ kind: "favicon", variant: "dark" });
  });

  test("neither stored, nothing picked", () => {
    expect(pickMarkAsset({ mark: none, favicon: none }, "dark")).toBeNull();
  });
});
