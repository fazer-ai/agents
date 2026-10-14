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
} from "@testing-library/react";
import { CredentialForm } from "@/client/components/CredentialForm";
import { ToastProvider } from "@/client/components/Toast";

// A typesafe key is used against its base URL when it has one, so Test has to probe that URL, typed
// or edited and not yet saved; a fixed-host kind sends none and its probe keeps the public host.

describe("the Test button probes the base URL the credential will be used with", () => {
  const realFetch = globalThis.fetch;
  const tests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("/test")) tests.push({ url, body });
    return new Response(JSON.stringify({ testable: true, ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  beforeEach(() => {
    tests.length = 0;
  });
  afterEach(cleanup);
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const secretInput = (): HTMLElement => {
    const el = document.querySelector('input[type="password"]');
    if (!el) throw new Error("no secret input rendered");
    return el as HTMLElement;
  };

  test("a typed value is probed on the typed base URL", async () => {
    render(
      <ToastProvider>
        <CredentialForm
          mode="create"
          initialKind="typesafe"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );
    fireEvent.change(
      screen.getByPlaceholderText("https://api.typesafe.ai/v1"),
      {
        target: { value: "https://ts-proxy.example.com/v1" },
      },
    );
    fireEvent.change(secretInput(), { target: { value: "ts-key" } });
    fireEvent.click(screen.getByText("Test connection"));
    await waitFor(() => expect(tests.length).toBe(1));
    expect(tests[0]?.body.kind).toBe("typesafe");
    expect(tests[0]?.body.baseURL).toBe("https://ts-proxy.example.com/v1");
  });

  test("a stored typesafe entry is probed on the base URL being edited", async () => {
    render(
      <ToastProvider>
        <CredentialForm
          mode="update"
          initialId="7"
          initialName="ts"
          initialKind="typesafe"
          initialBaseUrl="https://old-proxy.example.com/v1"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );
    fireEvent.change(
      screen.getByDisplayValue("https://old-proxy.example.com/v1"),
      {
        target: { value: "https://new-proxy.example.com/v1" },
      },
    );
    fireEvent.click(screen.getByText("Test connection"));
    await waitFor(() => expect(tests.length).toBe(1));
    expect(tests[0]?.url).toContain("/vault/7/test");
    expect(tests[0]?.body.baseURL).toBe("https://new-proxy.example.com/v1");
  });

  test("a fixed-host kind sends no base URL", async () => {
    render(
      <ToastProvider>
        <CredentialForm
          mode="create"
          initialKind="openai"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );
    fireEvent.change(secretInput(), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByText("Test connection"));
    await waitFor(() => expect(tests.length).toBe(1));
    expect(tests[0]?.body.baseURL ?? null).toBeNull();
  });
});
