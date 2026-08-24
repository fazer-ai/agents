/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";

// The letterhead form used to live on the page, where a save that finished was simply a save. It is
// a modal now, and the parent CLOSES the modal on `onSaved` — which turns two ordinary bits of
// timing into lost work:
//
//   the operator keeps typing while the request is out. `afterCompanySave` deliberately keeps those
//   keystrokes and marks them unsaved; announcing the save anyway closes the editor and throws them
//   away, which is exactly what the preservation exists to prevent.
//
//   the operator closes the editor and reopens it while the request is out. The older response then
//   closes the modal they are typing into NOW.

const { CompanyProfileCard } = await import(
  "@/client/pages/resources/documents/CompanyProfileCard"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");

const realFetch = globalThis.fetch;
const COMPANY = {
  name: "ACME Ltda",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
};

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function mount(opts: { session?: number; onSaved: (from?: number) => void }) {
  return render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard
            company={COMPANY as never}
            onChanged={() => undefined}
            onSaved={opts.onSaved}
            session={opts.session ?? 1}
          />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
}

function nameField(): HTMLInputElement {
  return screen.getAllByRole("textbox")[0] as HTMLInputElement;
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));
}

// Holds the PUT open until released, so the window between click and response is a real one.
function heldFetch() {
  let release: ((body: unknown) => void) | undefined;
  const held = new Promise<unknown>((r) => {
    release = r;
  });
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "PUT") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    calls++;
    await held;
    return new Response(JSON.stringify({ company: COMPANY }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { release: () => release?.(null), calls: () => calls };
}

test("a save does not announce itself over edits made while it was in flight", async () => {
  const held = heldFetch();
  let saved = 0;
  mount({ onSaved: () => saved++ });

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  save();
  await waitFor(() => {
    expect(held.calls()).toBe(1);
  });

  // The operator keeps typing into the still-open form.
  fireEvent.change(nameField(), { target: { value: "ACME Novíssima" } });
  held.release();
  await new Promise((r) => setTimeout(r, 50));

  // Not announced, so the modal stays open — and the newer text is still on screen, unsaved.
  expect(saved).toBe(0);
  expect(nameField().value).toBe("ACME Novíssima");
});

test("a save with nothing typed after it does announce itself", async () => {
  const held = heldFetch();
  let saved = 0;
  mount({ onSaved: () => saved++ });

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  save();
  await waitFor(() => {
    expect(held.calls()).toBe(1);
  });
  held.release();

  // The other direction, and it has to be asserted: a guard that never lets the modal close is the
  // same bug wearing the opposite sign.
  await waitFor(() => {
    expect(saved).toBe(1);
  });
});

// The card's half of the rule: it does not JUDGE the opening, it reports which one the save belongs
// to. The judgement moved to the parent, because this component unmounts with the modal (see the
// last test in this file) — but the parent can only judge with a number to judge, and the number has
// to be the one from when the request STARTED. A card that reported whatever session it happened to
// hold at response time would hand the parent the new one and pass every guard.
test("announces the opening the save belongs to, not the one on screen when it lands", async () => {
  const held = heldFetch();
  const reported: (number | undefined)[] = [];
  const view = mount({ session: 1, onSaved: (from) => reported.push(from) });

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  save();
  await waitFor(() => {
    expect(held.calls()).toBe(1);
  });

  // The prop moves on while the request is out. Same card, so this is the in-place half; the
  // unmount half is the last test in this file.
  view.rerender(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard
            company={COMPANY as never}
            onChanged={() => undefined}
            onSaved={(from) => reported.push(from)}
            session={2}
          />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
  held.release();
  await waitFor(() => {
    expect(reported.length).toBe(1);
  });
  expect(reported[0]).toBe(1);
});

// THE SAME RULE, ACROSS AN UNMOUNT — which the test above does NOT cover, and the difference is the
// whole finding. `rerender` keeps the component mounted, so its `sessionRef` follows the new prop.
// The real modal is a Radix dialog: closing it unmounts the card and reopening MOUNTS A NEW ONE. The
// old instance keeps running its request with a `session` and a `sessionRef` both frozen at the old
// value, so a guard the card owns compares them and finds them equal — and announces a save that
// belongs to a session nobody is looking at, closing the modal the operator just reopened.
//
// So the generation cannot be answered by the card. It is answered by the parent, which never
// unmounts, through a ref whose identity survives the stale closure holding it.
function CompanyHarness({ onClosed }: { onClosed: () => void }) {
  const [session, setSession] = useState(1);
  const sessionRef = useRef(1);
  const [open, setOpen] = useState(true);
  return (
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <button
            type="button"
            data-testid="close"
            onClick={() => setOpen(false)}
          >
            close
          </button>
          <button
            type="button"
            data-testid="reopen"
            onClick={() => {
              sessionRef.current += 1;
              setSession(sessionRef.current);
              setOpen(true);
            }}
          >
            reopen
          </button>
          {open ? (
            <CompanyProfileCard
              company={COMPANY as never}
              onChanged={() => undefined}
              onSaved={(from?: number) => {
                // The parent decides, reading the CURRENT generation off a ref rather than off a
                // value its own closure captured — the stale card holds a stale callback too.
                if (from !== undefined && from !== sessionRef.current) return;
                onClosed();
              }}
              session={session}
            />
          ) : null}
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>
  );
}

test("a save from a card that has since been unmounted does not close the new one", async () => {
  const held = heldFetch();
  let closed = 0;
  render(<CompanyHarness onClosed={() => closed++} />);

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  save();
  await waitFor(() => {
    expect(held.calls()).toBe(1);
  });

  // Discarded and reopened: a NEW card, and the old one's request is still out.
  fireEvent.click(screen.getByTestId("close"));
  fireEvent.click(screen.getByTestId("reopen"));
  held.release();
  await new Promise((r) => setTimeout(r, 50));

  expect(closed).toBe(0);
});
