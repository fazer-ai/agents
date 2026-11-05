/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Input } from "@/client/components/Input";
import { withI18n } from "@/tests/utils/i18n";

// The attributes Bitwarden, 1Password, LastPass and Dashlane read as "not a login field". A value
// that is not the user's password (a setup token, an API key) carries all of them, and a real
// password field carries none, so the managers keep offering to fill and save it.
const MANAGER_IGNORE = {
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
};

const attrs = (el: HTMLElement) =>
  Object.fromEntries(
    Object.keys(MANAGER_IGNORE).map((k) => [k, el.getAttribute(k)]),
  );

const box = () => screen.getByLabelText("Field") as HTMLInputElement;

describe("Input secret", () => {
  afterEach(() => cleanup());

  test("a secret text field opts out of every password manager and of autocomplete", () => {
    render(withI18n(<Input aria-label="Field" type="text" secret />));
    expect(box().type).toBe("text");
    expect(box().getAttribute("autocomplete")).toBe("off");
    expect(attrs(box())).toEqual(MANAGER_IGNORE);
  });

  test("a masked secret keeps the mask and the toggle, and still opts out", () => {
    render(
      withI18n(
        <Input aria-label="Field" type="password" showPasswordToggle secret />,
      ),
    );
    expect(box().type).toBe("password");
    expect(box().getAttribute("autocomplete")).toBe("off");
    expect(attrs(box())).toEqual(MANAGER_IGNORE);

    fireEvent.click(
      screen.getByRole("button", { name: /show password|mostrar senha/i }),
    );
    expect(box().type).toBe("text");
    expect(attrs(box())).toEqual(MANAGER_IGNORE);
  });

  test("a real password field stays a password field for the managers", () => {
    render(
      withI18n(<Input aria-label="Field" type="password" showPasswordToggle />),
    );
    expect(box().getAttribute("autocomplete")).toBe("new-password");
    expect(Object.values(attrs(box())).every((v) => v === null)).toBe(true);
  });
});
