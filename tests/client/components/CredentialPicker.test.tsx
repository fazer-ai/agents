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
import { CredentialPicker } from "@/client/components/CredentialPicker";
import { invalidateVault } from "@/client/lib/vaultCache";

// The picker resolves a ref to an entry the same way every resolver does, by the id BigInt reads out
// of it, so a ref stored as `vault: 7 ` or `vault:0x7` selects entry 7 instead of reading as an
// unavailable credential. Anything downstream of that selection has to use the ENTRY's id: the test
// route takes `^\d+$`, so passing the raw ref through would turn a working credential into
// "unreachable" — the picker recognizing the ref is what makes that reachable at all.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
let testUrls: string[] = [];

interface FakeEntry {
  id: string;
  name: string;
  kind: string;
  baseUrl: null;
  paramName: null;
  status: string;
}
const activeEntry: FakeEntry = {
  id: "7",
  name: "openai-main",
  kind: "openai",
  baseUrl: null,
  paramName: null,
  status: "active",
};
let vaultEntries: FakeEntry[] = [];

beforeEach(() => {
  invalidateVault();
  testUrls = [];
  vaultEntries = [activeEntry];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/test")) {
      testUrls.push(new URL(url, "http://localhost").pathname);
      return new Response(JSON.stringify({ testable: true, ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/v1/vault")) {
      return new Response(JSON.stringify({ entries: vaultEntries }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
});

afterEach(() => cleanup());
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("CredentialPicker with a noncanonical ref", () => {
  test("selects the entry and tests it by its own id", async () => {
    render(
      <CredentialPicker
        value="vault: 7 "
        onChange={() => {}}
        ariaLabel="key"
      />,
    );
    // Selected: the trigger names the entry rather than reporting it unavailable.
    await waitFor(() =>
      expect(screen.queryAllByText("openai-main").length > 0).toBe(true),
    );
    const testButton = screen.getByLabelText("Test connection");
    testButton.click();
    await waitFor(() => expect(testUrls.length).toBe(1));
    expect(testUrls[0]).toBe("/api/v1/vault/7/test");
  });
});

// A referenced entry whose secret was never filled. `credential_create` and the vault both produce
// this on purpose; unless the picker says so, an integration wired to one fails as a bare 401.
describe("CredentialPicker with a pending entry", () => {
  // The sentence shares its element with the Fill control, so match a fragment.
  const warning = /no value yet/;

  test("says the secret is missing, and offers to fill it in place", async () => {
    vaultEntries = [{ ...activeEntry, status: "pending" }];
    render(
      <CredentialPicker value="vault:7" onChange={() => {}} ariaLabel="key" />,
    );
    await waitFor(() =>
      expect(screen.queryAllByText("openai-main").length > 0).toBe(true),
    );
    expect(screen.queryAllByText(warning).length > 0).toBe(true);
    // In place, not a link to the vault page: the operator is mid-edit on a form whose unsaved
    // state a navigation would throw away.
    expect(screen.queryAllByRole("button", { name: "Fill" }).length).toBe(1);
  });

  test("says nothing when the entry holds a secret", async () => {
    render(
      <CredentialPicker value="vault:7" onChange={() => {}} ariaLabel="key" />,
    );
    await waitFor(() =>
      expect(screen.queryAllByText("openai-main").length > 0).toBe(true),
    );
    expect(screen.queryAllByText(warning).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Fill" }).length).toBe(0);
  });
});

// The context lists its own kind first (the classifier's provider kind before a generic key), and the
// compatible group follows that order, with the vault's name order within a kind. Before this, the
// group was the vault's name order alone, so a generic key named "a…" sat above the provider's own.
describe("CredentialPicker ranks the compatible group by the context's kind order", () => {
  const entry = (id: string, name: string, kind: string): FakeEntry => ({
    id,
    name,
    kind,
    baseUrl: null,
    paramName: null,
    status: "active",
  });

  test("the provider's own kind first, names in order within each kind, others apart", async () => {
    // The vault answers in name order, as the server does.
    vaultEntries = [
      entry("1", "a-generic", "generic"),
      entry("2", "b-typesafe", "typesafe"),
      entry("3", "c-openai", "openai"),
      entry("4", "d-generic", "generic"),
      entry("5", "e-typesafe", "typesafe"),
    ];
    render(
      <CredentialPicker
        value=""
        onChange={() => {}}
        ariaLabel="key"
        compatibleTypes={["typesafe", "generic"]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("key").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.pointerDown(screen.getByLabelText("key"), {
      button: 0,
      pointerType: "mouse",
    });
    await waitFor(() =>
      expect(screen.queryAllByRole("menu", { hidden: true }).length).toBe(1),
    );
    // Each row carries the entry's name and its kind's label; read which entry a row is by name.
    const known = vaultEntries.map((e) => e.name);
    const names = within(screen.getByRole("menu", { hidden: true }))
      .getAllByRole("menuitem", { hidden: true })
      .map((el) => known.find((n) => (el.textContent ?? "").includes(n)))
      .filter((n): n is string => !!n);
    expect(names.join(",")).toBe("b-typesafe,e-typesafe,a-generic,d-generic");
  });
});
