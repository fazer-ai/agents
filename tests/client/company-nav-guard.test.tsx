/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { NavGuardProvider } from "@/client/contexts/NavGuardContext";
import {
  type CompanyProfile,
  CompanyProfileCard,
} from "@/client/pages/resources/documents/CompanyProfileCard";

// The letterhead is the only form on the Documents tab that is NOT inside a modal, so nothing else
// stands between an unsaved edit and a click on another tab — or on a tenant switch, which is a full
// reload. The agent editor and the template modal both register with the guard; this one did not,
// and the edits went silently.
//
// Driven through a real <a> click, because that is what the guard actually intercepts (a
// capture-phase document listener that pre-empts react-router's own handler). Asserting on the
// component's internal dirty flag would pass without the registration that makes it matter.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

// happy-dom starts at about:blank, where the guard's same-origin test cannot resolve a relative
// href — so the page it thinks it is on has to be a real URL before anything is rendered.
//
// Reset BEFORE EACH test, not once: the guard pushes a history sentinel while it is active, which
// moves window.location for whatever runs next. Left shared, a later test compares the link against
// the sentinel's path instead of the page's and quietly stops intercepting — the file passed while
// the same test failed on its own.
const setUrl = () =>
  (globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
    "http://localhost/recursos/documentos",
  );
setUrl();
beforeEach(setUrl);

const company = {
  name: "ACME Ltda",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
} as unknown as CompanyProfile;

function mount() {
  return render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <NavGuardProvider>
          <CompanyProfileCard company={company} onChanged={() => {}} />
          <a href="/recursos/agentes">Agentes</a>
        </NavGuardProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const guardShowing = () =>
  document.body.textContent?.toLowerCase().includes("discard") === true ||
  document.body.textContent?.toLowerCase().includes("descartar") === true;

afterEach(cleanup);

describe("the company profile registers with the navigation guard", () => {
  test("an unsaved edit is confirmed before leaving", () => {
    mount();
    const input = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ACME Ltda ME" } });
    fireEvent.click(screen.getByText("Agentes"));
    expect(guardShowing()).toBe(true);
  });

  test("an untouched form leaves without asking", () => {
    mount();
    fireEvent.click(screen.getByText("Agentes"));
    expect(guardShowing()).toBe(false);
  });

  // Typing back to what the server holds is not an edit: the guard has to let go again, or the
  // operator is asked to discard changes they no longer have.
  test("typing back to the stored value releases the guard", () => {
    mount();
    const input = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ACME Ltda ME" } });
    fireEvent.change(input, { target: { value: "ACME Ltda" } });
    fireEvent.click(screen.getByText("Agentes"));
    expect(guardShowing()).toBe(false);
  });
});
