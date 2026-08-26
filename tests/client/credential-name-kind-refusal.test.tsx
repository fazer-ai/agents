/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// UNIQUENESS IN THE VAULT IS THE (NAME, KIND) PAIR, AND THE MARK EXPIRES BY THE NAME.
//
// A held refusal comes off the control when the box stops holding what the server refused, which is
// what keeps it from needing an `onChange` line per input. `assertUniqueVaultName` refuses the pair,
// though, so a duplicate answered for (Alfa, openai) says nothing at all about (Alfa, anthropic) —
// and switching type while keeping the name leaves "already in use" standing under a name that is
// free. The read is by value, so nothing about the switch expires it.
//
// NOTE: assertions reduce to a string or a boolean BEFORE expect: a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls.

const { CredentialForm } = await import("@/client/components/CredentialForm");
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
const REASON = "A secret with this name and type already exists";

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

// Holds one leg of the save until the test lets it go, so the type picker can be tried while it is
// out. Two legs, because `save()` probes the typed value BEFORE it marks itself saving: a window
// covered by `testing` and a window covered by `saving`, and a lock on one of them is half a lock.
let holdProbe: Promise<void> | null = null;
let holdWrite: Promise<void> | null = null;

function refusing(body: { error: string; field?: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // The form probes before it writes; a probe that fails relabels Save and is not what this is
    // about.
    if (url.includes("/v1/vault/test")) {
      if (holdProbe) await holdProbe;
      return new Response(JSON.stringify({ testable: true, ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      url.includes("/v1/vault") &&
      !url.includes("/test")
    ) {
      if (holdWrite) await holdWrite;
      return new Response(JSON.stringify(body), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("switching the type drops a name conflict the new pair never had", async () => {
  refusing({ error: REASON, field: "name" });
  const { container } = render(
    <ToastProvider>
      <CredentialForm
        mode="create"
        initialKind="openai"
        onSaved={() => {}}
        onCancel={() => {}}
      />
    </ToastProvider>,
  );

  const name = screen.getByRole("textbox", { name: /name|nome/i });
  fireEvent.change(name, { target: { value: "Alfa" } });
  const value = container.querySelector('input[type="password"]');
  if (!value) throw new Error("no secret input rendered");
  fireEvent.change(value, { target: { value: "sk-secret" } });
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));

  await waitFor(() => {
    expect(screen.queryAllByText(REASON).length).toBeGreaterThan(0);
  });

  // The type picker, and then a different provider. Same name, a pair the server has said nothing
  // about.
  const picker = screen.getByRole("button", { name: /type|tipo/i });
  // Radix opens its menu on pointerdown, not on a synthesized click.
  fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
  fireEvent.click(picker);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /^anthropic$/i }),
  );

  await waitFor(() => {
    expect(screen.queryAllByText(REASON).length).toBe(0);
  });
});

// Both names the `.env` textarea stands in for. `baseUrl` has its own box for every other kind, and
// disappears with the per-key inputs the moment the operator switches to pasting.
test.each(["publicKey", "baseUrl"])(
  "a %s refused in .env mode is read out, not marked on a hidden input",
  async (field) => {
    // Langfuse opens in paste mode: the per-key boxes are replaced by one `.env` textarea, so
    // `publicKey` — the name `assertNoSurroundingWhitespace` refuses by — has no control on screen.
    // Declaring it anyway placed the sentence on nothing and told `capture` to keep the toast quiet.
    const reason = `refused: ${field}`;
    refusing({ error: reason, field });
    render(
      <ToastProvider>
        <CredentialForm
          mode="create"
          initialKind="langfuse"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: /name|nome/i }), {
      target: { value: "Alfa" },
    });
    const env = screen.getByRole("textbox", { name: /langfuse \.env/i });
    fireEvent.change(env, {
      target: {
        value:
          'LANGFUSE_PUBLIC_KEY="pk-lf-1"\nLANGFUSE_SECRET_KEY="sk-lf-1"\nLANGFUSE_BASE_URL="https://cloud.langfuse.com"',
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));

    await waitFor(() => {
      expect(screen.queryAllByText(reason).length).toBeGreaterThan(0);
    });
    // Nowhere near a control: there is no `publicKey` box in this mode.
    const marked = screen
      .queryAllByText(reason)
      .some((n) => !!n.closest("label, [role='group']"));
    expect(marked).toBe(false);
  },
);

test.each(["probe", "write"] as const)(
  "the type cannot change out from under a save waiting on its %s",
  async (leg) => {
    // The race the clear on select cannot answer: it runs first, and the 409 for the OLD pair lands
    // after it, reattaching a conflict under a pair the server has said nothing about. The mark
    // expires by the name, and the name did not change.
    refusing({ error: REASON, field: "name" });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    if (leg === "probe") holdProbe = held;
    else holdWrite = held;
    const { container } = render(
      <ToastProvider>
        <CredentialForm
          mode="create"
          initialKind="openai"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: /name|nome/i }), {
      target: { value: "Alfa" },
    });
    const value = container.querySelector('input[type="password"]');
    if (!value) throw new Error("no secret input rendered");
    fireEvent.change(value, { target: { value: "sk-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));

    const picker = await screen.findByRole("button", { name: /type|tipo/i });
    await waitFor(() => {
      expect((picker as HTMLButtonElement).disabled).toBe(true);
    });
    // And it does not open, which is the half a disabled attribute alone would not prove.
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(picker);
    expect(screen.queryAllByRole("menuitem").length).toBe(0);

    release();
    holdProbe = null;
    holdWrite = null;
    await waitFor(() => {
      expect(screen.queryAllByText(REASON).length).toBeGreaterThan(0);
    });
  },
);
