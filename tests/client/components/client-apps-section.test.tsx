/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { ClientAppsSection } from "@/client/components/client-apps/ClientAppsSection";
import { withI18n } from "@/tests/utils/i18n";

// The embedding applications in the agent editor: each app with its origins and the keys that still
// verify, an app with no valid key said so, and the key minted by "New application" shown once, with
// the origins sent one per line and the operator's password alongside.
//
// Every assertion reduces to a string BEFORE expect: a failing expectation still holding a DOM node
// serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const sent: Array<{ method: string; path: string; body: unknown }> = [];
let apps: unknown[] = [];
let postGate: Promise<void> | null = null;

beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(String(req ? req.url : input), "http://localhost");
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const rawBody = init?.body ?? (req ? await req.clone().text() : undefined);
    const body =
      typeof rawBody === "string" && rawBody ? JSON.parse(rawBody) : null;
    sent.push({ method, path: url.pathname, body });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/api/v1/client-apps" && method === "GET")
      return json({ clientApps: apps });
    if (url.pathname === "/api/v1/client-apps" && method === "POST") {
      if (postGate) await postGate;
      return json({
        clientApp: { ...(apps[0] as object), publicId: "app_novo" },
        secret: { kid: "key_novo", secret: "segredo-uma-vez" },
      });
    }
    return json({ error: "nope" }, 500);
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
  sent.length = 0;
  postGate = null;
});

function mount() {
  return render(
    withI18n(
      <MemoryRouter>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <ClientAppsSection agentId="5" />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
}

const APP = {
  id: "7",
  agentId: "5",
  name: "Sinete",
  publicId: "app_abc",
  allowedOrigins: ["https://app.exemplo.com", "http://localhost:3048"],
  anonymousEnabled: false,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  anonExpiryDays: 30,
  monthlyCeilingUsd: null,
  monthSpendUsd: null,
  turnstileEnabled: false,
  turnstileSiteKey: null,
  turnstileSecretSet: false,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
};

describe("embedding applications in the agent editor", () => {
  test("an app shows its origins and the keys that still verify", async () => {
    apps = [
      {
        ...APP,
        secrets: [
          { kid: "key_nova", createdAt: APP.createdAt, expiresAt: null },
          {
            kid: "key_velha",
            createdAt: APP.createdAt,
            expiresAt: "2026-10-10T00:00:00.000Z",
          },
        ],
      },
    ];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    const text = container.textContent ?? "";
    expect({
      publicId: text.includes("app_abc"),
      origins: APP.allowedOrigins.every((o) => text.includes(o)),
      current: text.includes("key_nova") && text.includes("current"),
      expiring: text.includes("key_velha") && text.includes("works until"),
      noKey: text.includes("No valid key"),
    }).toEqual({
      publicId: true,
      origins: true,
      current: true,
      expiring: true,
      noKey: false,
    });
    expect(sent[0]?.path + String(sent[0]?.method)).toBe(
      "/api/v1/client-appsGET",
    );
  });

  test("an app with no valid key says it signs nobody in", async () => {
    apps = [{ ...APP, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    expect(container.textContent?.includes("No valid key")).toBe(true);
  });

  test("a new application sends the origins and the password, and shows the key once", async () => {
    apps = [{ ...APP, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    fireEvent.click(screen.getByRole("button", { name: "New application" }));
    const dialog = await screen.findByRole("dialog");
    const inputs = dialog.querySelectorAll("input");
    const textarea = dialog.querySelector("textarea");
    if (!textarea || inputs.length < 2) throw new Error("form not found");
    fireEvent.change(inputs[0] as HTMLInputElement, {
      target: { value: "Painel" },
    });
    fireEvent.change(textarea, {
      target: { value: "https://a.exemplo.com\nhttps://b.exemplo.com" },
    });
    const password = dialog.querySelector('input[type="password"]');
    if (!password) throw new Error("no password field");
    fireEvent.change(password, { target: { value: "minha-senha" } });
    fireEvent.click(screen.getByRole("button", { name: "Create application" }));
    await waitFor(() => {
      if (!document.body.textContent?.includes("segredo-uma-vez"))
        throw new Error("wait");
    });
    const post = sent.find((s) => s.method === "POST");
    expect(post?.body).toEqual({
      agentId: "5",
      name: "Painel",
      allowedOrigins: ["https://a.exemplo.com", "https://b.exemplo.com"],
      anonymousEnabled: false,
      monthlyCeilingUsd: null,
      anonSessionsPerHour: 20,
      anonMessagesPerMin: 10,
      anonExpiryDays: 30,
      password: "minha-senha",
    });
    expect(document.body.textContent?.includes("key_novo")).toBe(true);
  });

  test("an edited application asks before Escape discards it, and an untouched one just closes", async () => {
    apps = [{ ...APP, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    const pressEscape = () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("dialog");
    pressEscape();
    await waitFor(() => {
      if (screen.queryByRole("dialog")) throw new Error("still open");
    });
    const untouchedAsked =
      document.body.textContent?.includes("Discard changes?");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const toggle = dialog.querySelector('[role="switch"]');
    if (!toggle) throw new Error("no switch");
    fireEvent.click(toggle);
    pressEscape();
    await waitFor(() => {
      if (!document.body.textContent?.includes("Discard changes?"))
        throw new Error("wait");
    });
    expect(untouchedAsked).toBe(false);
  });

  test("the anonymous limits show with anonymous visitors on, refuse a value out of range, and are sent", async () => {
    apps = [{ ...APP, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const numbers = () =>
      [
        ...dialog.querySelectorAll('input[type="number"]'),
      ] as HTMLInputElement[];
    const save = () =>
      screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const hiddenWhileOff = numbers().length;
    fireEvent.click(dialog.querySelector('[role="switch"]') as Element);
    await waitFor(() => {
      if (numbers().length !== 3) throw new Error("wait");
    });
    fireEvent.change(numbers()[0] as HTMLInputElement, {
      target: { value: "0" },
    });
    const refused = save().disabled;
    fireEvent.change(numbers()[0] as HTMLInputElement, {
      target: { value: "50" },
    });
    fireEvent.change(numbers()[2] as HTMLInputElement, {
      target: { value: "366" },
    });
    const refusedExpiry = save().disabled;
    fireEvent.change(numbers()[2] as HTMLInputElement, {
      target: { value: "7" },
    });
    fireEvent.click(save());
    await waitFor(() => {
      if (!sent.some((x) => x.method === "PATCH")) throw new Error("wait");
    });
    expect({
      hiddenWhileOff,
      refused,
      refusedExpiry,
      body: sent.find((x) => x.method === "PATCH")?.body,
    }).toEqual({
      hiddenWhileOff: 0,
      refused: true,
      refusedExpiry: true,
      body: {
        name: "Sinete",
        allowedOrigins: APP.allowedOrigins,
        anonymousEnabled: true,
        monthlyCeilingUsd: null,
        anonSessionsPerHour: 50,
        anonMessagesPerMin: 10,
        anonExpiryDays: 7,
        turnstileEnabled: false,
        turnstileSiteKey: null,
      },
    });
  });

  test("a limit left invalid and hidden by turning anonymous visitors off does not block the save", async () => {
    apps = [{ ...APP, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const toggle = dialog.querySelector('[role="switch"]') as Element;
    fireEvent.click(toggle);
    await waitFor(() => {
      if (!dialog.querySelector('input[type="number"]'))
        throw new Error("wait");
    });
    fireEvent.change(
      dialog.querySelector('input[type="number"]') as HTMLInputElement,
      {
        target: { value: "" },
      },
    );
    fireEvent.click(toggle);
    fireEvent.change(dialog.querySelector("input") as HTMLInputElement, {
      target: { value: "Sinete 2" },
    });
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    const enabled = !save.disabled;
    fireEvent.click(save);
    await waitFor(() => {
      if (!sent.some((x) => x.method === "PATCH")) throw new Error("wait");
    });
    expect({
      enabled,
      body: sent.find((x) => x.method === "PATCH")?.body,
    }).toEqual({
      enabled: true,
      body: {
        name: "Sinete 2",
        allowedOrigins: APP.allowedOrigins,
        anonymousEnabled: false,
        monthlyCeilingUsd: null,
        anonMessagesPerMin: 10,
        anonExpiryDays: 30,
      },
    });
  });

  test("the monthly ceiling is sent in dollars, refuses what is not an amount, and shows this month's spend", async () => {
    apps = [{ ...APP, monthlyCeilingUsd: 20, monthSpendUsd: 7.5, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    const shown = container.textContent?.includes("$7.50 of $20.00 this month");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const field = dialog.querySelector(
      'input[placeholder="No ceiling"]',
    ) as HTMLInputElement;
    const save = () =>
      screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const prefilled = field.value;
    fireEvent.change(field, { target: { value: "doze" } });
    const refused = save().disabled;
    fireEvent.change(field, { target: { value: "12,50" } });
    fireEvent.click(save());
    await waitFor(() => {
      if (!sent.some((x) => x.method === "PATCH")) throw new Error("wait");
    });
    expect({
      shown,
      prefilled,
      refused,
      ceiling: (
        sent.find((x) => x.method === "PATCH")?.body as {
          monthlyCeilingUsd?: unknown;
        }
      )?.monthlyCeilingUsd,
    }).toEqual({ shown: true, prefilled: "20", refused: true, ceiling: 12.5 });
  });

  test("the Turnstile challenge sits under anonymous visitors, needs its two keys, and keeps a stored secret left empty", async () => {
    apps = [{ ...APP, anonymousEnabled: true, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const switches = () => [...dialog.querySelectorAll('[role="switch"]')];
    const save = () =>
      screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const secretField = () =>
      dialog.querySelector('input[type="password"]') as HTMLInputElement | null;
    const switchesWithAnonymous = switches().length;
    fireEvent.click(switches()[1] as Element);
    await waitFor(() => {
      if (!secretField()) throw new Error("wait");
    });
    const blockedEmpty = save().disabled;
    const siteKey = screen.getByLabelText(/Site key/) as HTMLInputElement;
    fireEvent.change(siteKey, { target: { value: "0x4AAAAAAAchave" } });
    const blockedNoSecret = save().disabled;
    fireEvent.change(secretField() as HTMLInputElement, {
      target: { value: "segredo" },
    });
    fireEvent.click(save());
    await waitFor(() => {
      if (!sent.some((x) => x.method === "PATCH")) throw new Error("wait");
    });
    const body = sent.find((x) => x.method === "PATCH")?.body as Record<
      string,
      unknown
    >;
    expect({
      switchesWithAnonymous,
      blockedEmpty,
      blockedNoSecret,
      turnstile: [
        body.turnstileEnabled,
        body.turnstileSiteKey,
        body.turnstileSecret,
      ],
    }).toEqual({
      switchesWithAnonymous: 2,
      blockedEmpty: true,
      blockedNoSecret: true,
      turnstile: [true, "0x4AAAAAAAchave", "segredo"],
    });
  });

  test("with a secret stored, the challenge saves without retyping it, and none is sent", async () => {
    apps = [
      {
        ...APP,
        anonymousEnabled: true,
        turnstileEnabled: true,
        turnstileSiteKey: "0x4AAAAAAAchave",
        turnstileSecretSet: true,
        secrets: [],
      },
    ];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("input") as HTMLInputElement, {
      target: { value: "Sinete 2" },
    });
    const stored = dialog.textContent?.includes(
      "A secret is stored. Leave empty to keep it.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      if (!sent.some((x) => x.method === "PATCH")) throw new Error("wait");
    });
    const body = sent.find((x) => x.method === "PATCH")?.body as Record<
      string,
      unknown
    >;
    expect({
      stored,
      enabled: body.turnstileEnabled,
      sentSecret: "turnstileSecret" in body,
    }).toEqual({ stored: true, enabled: true, sentSecret: false });
  });

  test("Cancel on a filled-in new application asks before discarding it", async () => {
    apps = [{ ...APP, secrets: [] }];
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    fireEvent.click(screen.getByRole("button", { name: "New application" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("input") as HTMLInputElement, {
      target: { value: "Painel" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      if (!document.body.textContent?.includes("Discard changes?"))
        throw new Error("wait");
    });
    expect(screen.queryAllByRole("dialog").length > 0).toBe(true);
  });

  test("while the key is being minted the dialog cannot be dismissed, and the key lands in it", async () => {
    apps = [{ ...APP, secrets: [] }];
    let release = () => {};
    postGate = new Promise<void>((r) => {
      release = r;
    });
    const { container } = mount();
    await waitFor(() => {
      if (!container.textContent?.includes("Sinete")) throw new Error("wait");
    });
    fireEvent.click(screen.getByRole("button", { name: "New application" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("input") as HTMLInputElement, {
      target: { value: "Painel" },
    });
    fireEvent.change(dialog.querySelector("textarea") as HTMLTextAreaElement, {
      target: { value: "https://a.exemplo.com" },
    });
    fireEvent.change(
      dialog.querySelector('input[type="password"]') as HTMLInputElement,
      { target: { value: "minha-senha" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create application" }));
    await waitFor(() => {
      if (!sent.some((x) => x.method === "POST")) throw new Error("wait");
    });
    // NOTE: dispatched inside `act`, so whatever the Escape changes has rendered when it returns.
    fireEvent.keyDown(document, { key: "Escape" });
    const during = {
      open: screen.queryByRole("dialog") !== null,
      asked: document.body.textContent?.includes("Discard changes?") ?? false,
    };
    release();
    await waitFor(() => {
      if (!document.body.textContent?.includes("segredo-uma-vez"))
        throw new Error("wait");
    });
    expect(during).toEqual({ open: true, asked: false });
  });
});
