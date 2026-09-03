/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { CredentialForm } from "@/client/components/CredentialForm";
import { ToastProvider } from "@/client/components/Toast";

// The write refuses a param name on a kind that declares none (issue #488), and the argument for
// that refusal being safe is that the CONSOLE can never send one: the input is drawn only under
// `needsParamName`, and every payload gates on the same flag. That is a claim about REACHABILITY,
// and reachability is measured, not read — so this drives the one path where the two can disagree.
// A param name typed while the type was `header` survives in form state after the operator switches
// the type to `generic`, and if the payload carried it, the save would come back 400 naming a field
// the form no longer renders: a refusal with no door.

describe("CredentialForm never sends a param name a kind cannot use", () => {
  const realFetch = globalThis.fetch;
  const calls: {
    method: string;
    url: string;
    body: Record<string, unknown>;
  }[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, url, body });
    if (url.includes("/api/v1/vault/test")) {
      return new Response(JSON.stringify({ testable: false }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "1", ref: "vault:1" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(cleanup);
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const posts = () =>
    calls.filter((c) => c.method === "POST" && !c.url.includes("/vault/test"));

  // NOTE: the value input carries no placeholder on create (only on update, where blank keeps the
  // stored secret), so it is addressed by its type.
  const secretInput = (): HTMLElement => {
    const el = document.querySelector('input[type="password"]');
    if (!el) throw new Error("no secret input rendered");
    return el as HTMLElement;
  };

  // NOTE: Radix opens on pointerdown with a real pointerType, not on click, and the FormField label
  // carries the same accessible name as the trigger — so this asks for the BUTTON, and then reads
  // the option INSIDE the menu (an open menu takes the rest of the form out of the a11y tree).
  const pickType = async (label: string) => {
    fireEvent.pointerDown(screen.getByRole("button", { name: "Type" }), {
      button: 0,
      pointerType: "mouse",
    });
    await waitFor(() =>
      expect(screen.queryAllByRole("menu", { hidden: true }).length).toBe(1),
    );
    const menu = screen.getByRole("menu", { hidden: true });
    // NOTE: by ROLE, not by text: the type list renders the label more than once (the row and its
    // hint), and a bare text query is ambiguous.
    const item = within(menu)
      .getAllByRole("menuitem", { hidden: true })
      .find((el) => (el.textContent ?? "").trim().startsWith(label));
    if (!item) throw new Error(`no menu item for ${label}`);
    fireEvent.click(item);
    await waitFor(() =>
      expect(screen.queryAllByRole("menu", { hidden: true }).length).toBe(0),
    );
  };

  test("a name typed under `header` does not travel after the type is switched to `generic`", async () => {
    render(
      <ToastProvider>
        <CredentialForm
          mode="create"
          initialKind="header"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );

    // NOTE: the input exists only because the type is `header` — that is the premise being tested.
    const paramInput = screen.getByPlaceholderText("X-API-Key");
    fireEvent.change(paramInput, { target: { value: "Authorization" } });

    await pickType("Generic");
    // NOTE: by LABEL, not by placeholder: the placeholder is derived from the kind ("X-API-Key" for
    // header, "api_key" otherwise), so a form that kept drawing the field for `generic` would still
    // satisfy a query for the header one. Measured — that mutation survived until this line asked
    // by the name the field actually carries.
    expect(screen.queryByText("Parameter name")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("my-api-key"), {
      target: { value: "avec-jwt" },
    });
    fireEvent.change(secretInput(), {
      target: { value: "eyJhbGciOiJIUzI1NiJ9.e30.sig" },
    });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(posts().length).toBe(1));

    const sent = posts()[0]?.body ?? {};
    expect(sent.kind ?? null).toBeNull();
    expect("paramName" in sent && sent.paramName !== undefined).toBe(false);
  });

  test("and it DOES travel while the type still takes one — the control", async () => {
    render(
      <ToastProvider>
        <CredentialForm
          mode="create"
          initialKind="header"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText("X-API-Key"), {
      target: { value: "Authorization" },
    });
    fireEvent.change(screen.getByPlaceholderText("my-api-key"), {
      target: { value: "avec-header" },
    });
    fireEvent.change(secretInput(), {
      target: { value: "eyJhbGciOiJIUzI1NiJ9.e30.sig" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]?.body.paramName).toBe("Authorization");
  });
});
