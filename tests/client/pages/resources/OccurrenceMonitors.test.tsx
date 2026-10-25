/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  BrowserRouter,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { NavGuardProvider } from "@/client/contexts/NavGuardContext";
import { invalidateVault } from "@/client/lib/vaultCache";
import { OccurrencesPanel } from "@/client/pages/resources/OccurrencesPanel";

await import("@/client/lib/i18n");

// The account's monitors: the list says, for each one, whether it is on, what it reads and when it
// last ran, and a row only opens its monitor; New takes a name and keeps a refusal in the form. In
// the monitor's view the name is edited in place, Duplicate asks for the copy's name and opens it,
// and Delete asks on the page with what goes with it; an inbox another monitor also reads says so.

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CONFIG = {
  enabled: false,
  inboxIds: [] as string[],
  fields: [
    { key: "motivo", name: "Motivo", description: "y", attribute: false },
  ],
  reasonField: "motivo",
  referenceField: null,
  cadenceMinutes: 15,
  consolidationMinutes: 60,
  newMinConversations: 5,
  windowMinutes: 60,
  previousDays: 7,
  aboveUsualRatio: 3,
  concentrationShare: 0.6,
  flagHoldMinutes: 120,
  newWithinMinutes: 360,
  model: {
    provider: "openai",
    model: "gpt-5-mini",
    credentialRef: "vault:3",
    baseURL: null,
  },
  businessContext: "",
  recoverMedia: false,
};

type Monitor = {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  inboxIds: string[];
  lastRun: null | { startedAt: string; finishedAt: string; status: string };
  openThemes: number;
  runs: number;
};

const INBOX = (id: string, name: string) => ({
  id,
  chatwootInstanceId: "1",
  chatwootInboxId: Number(id),
  name,
  channelType: "Channel::Whatsapp",
  provider: null,
  agentId: "7",
  observerAgentIds: [],
  voiceAgentId: null,
});

let monitors: Monitor[] = [];
// When set, a GET of the list waits for the promise it returns, so a test decides which read lands
// last; `listAnswered` counts the reads that answered.
let listGate: (() => Promise<void> | null) | null = null;
let listAnswered = 0;
// Answers a write instead of the default, so a test can make the server refuse it.
let refuse:
  | ((method: string, path: string) => Response | Promise<Response> | null)
  | null = null;
// Holds the create until the test lets it answer.
let createGate: Promise<void> | null = null;

function installFetchStub() {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    requests.push({ method, path, body });
    const refused = refuse?.(method, path);
    if (refused) return await refused;
    if (path === "/api/v1/occurrences/monitors" && method === "GET") {
      const snapshot = monitors.map((m) => ({ ...m }));
      const gate = listGate?.();
      if (gate) await gate;
      listAnswered += 1;
      return json({ instance: {}, monitors: snapshot, max: 10 });
    }
    if (path === "/api/v1/occurrences/monitors" && method === "POST") {
      if (createGate) await createGate;
      const m: Monitor = {
        id: String(100 + monitors.length),
        name: body.name,
        position: monitors.length,
        enabled: false,
        inboxIds: [],
        lastRun: null,
        openThemes: 0,
        runs: 0,
      };
      monitors = [...monitors, m];
      return json({ instance: {}, monitor: m }, 201);
    }
    const one = /^\/api\/v1\/occurrences\/monitors\/(\d+)(\/.*)?$/.exec(path);
    if (one) {
      const [, id, rest = ""] = one;
      const m = monitors.find((x) => x.id === id);
      if (!m) return json({ error: "not found" }, 404);
      if (rest === "" && method === "GET")
        return json({ instance: {}, monitor: m, occurrences: CONFIG });
      if (rest === "" && method === "PATCH") {
        m.name = body.name;
        return json({ instance: {}, monitor: m });
      }
      if (rest === "" && method === "DELETE") {
        monitors = monitors.filter((x) => x.id !== id);
        return json({
          instance: {},
          deleted: true,
          openThemes: m.openThemes,
          runs: m.runs,
        });
      }
      if (rest === "/duplicate" && method === "POST") {
        const copy: Monitor = {
          ...m,
          id: String(200 + monitors.length),
          name: body?.name ?? `${m.name} (2)`,
          enabled: false,
          inboxIds: [],
          lastRun: null,
          openThemes: 0,
          runs: 0,
        };
        monitors = [...monitors, copy];
        return json({ instance: {}, monitor: copy }, 201);
      }
      if (rest === "/config" && method === "GET")
        return json({
          instance: {},
          occurrences: { ...CONFIG, enabled: m.enabled, inboxIds: m.inboxIds },
        });
      if (rest === "/config" && method === "PUT")
        return json({
          instance: {},
          occurrences: {
            ...CONFIG,
            enabled: m.enabled,
            inboxIds: m.inboxIds,
            ...body,
          },
        });
      if (rest === "/runs")
        return json({ instance: {}, runs: [], total: 0, nextBefore: null });
      if (rest === "/cost")
        return json({
          instance: {},
          last7Days: { costUsd: 0, calls: 0, unpricedCalls: 0 },
          last30Days: { costUsd: 0, calls: 0, unpricedCalls: 0 },
        });
      if (rest === "/themes")
        return json({ instance: {}, themes: [], total: 0 });
    }
    if (path === "/api/v1/metrics/filter-options")
      return json({ instance: {}, agents: [], inboxes: [] });
    if (path === "/api/v1/chatwoot/inboxes")
      return json({
        instance: {},
        inboxes: [
          INBOX("1", "Compras WhatsApp"),
          INBOX("3", "Produtores WhatsApp"),
        ],
      });
    if (path === "/api/v1/vault")
      return json({
        instance: {},
        entries: [
          {
            id: "3",
            name: "openai",
            kind: "openai",
            status: "active",
            baseUrl: null,
            paramName: null,
          },
        ],
      });
    return json({}, 404);
  }) as typeof fetch;
}

let location = "";
// A link followed while the page is mounted.
let navigateTo: (to: string) => void = () => {};
function LocationProbe() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  navigateTo = useNavigate();
  return null;
}

const renderPanel = (path = "/resources/occurrences") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <NavGuardProvider>
        <ToastProvider>
          <OccurrencesPanel />
          <LocationProbe />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );

const A: Monitor = {
  id: "1",
  name: "Compradores",
  position: 0,
  enabled: true,
  inboxIds: ["1"],
  lastRun: {
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    status: "ok",
  },
  openThemes: 4,
  runs: 6,
};
const B: Monitor = {
  id: "2",
  name: "Produtores",
  position: 1,
  enabled: false,
  inboxIds: [],
  lastRun: null,
  openThemes: 0,
  runs: 0,
};

const rowOf = (name: string) =>
  screen.getByText(name).closest("li") as HTMLElement;
// The header's name form, open after Rename.
const nameForm = () =>
  screen.getByLabelText("Monitor name").closest("form") as HTMLElement;

// The page guard traps browser Back with a history sentinel kept at module level. A browser's
// history.back() always ends in a popstate; landing it at once keeps one test's leave from being
// taken for the next test's Back, and a cleanup another file left on the way is landed first.
let back: ReturnType<typeof spyOn>;
beforeEach(() => {
  back = spyOn(window.history, "back").mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  window.dispatchEvent(new PopStateEvent("popstate"));
});

afterEach(() => {
  back.mockRestore();
  cleanup();
  monitors = [];
  refuse = null;
  listGate = null;
  listAnswered = 0;
  createGate = null;
  // The vault list is cached per process: this file's stub must not answer another file's reads.
  invalidateVault();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("occurrence monitors", () => {
  test("the list says for each monitor whether it is on, what it reads and when it last ran", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    const a = rowOf("Compradores");
    expect(within(a).getByText("on")).toBeTruthy();
    expect(a.textContent).toContain("Compras WhatsApp");
    expect(a.textContent).toContain("last round");
    const b = rowOf("Produtores");
    expect(within(b).getByText("off")).toBeTruthy();
    expect(b.textContent).toContain("no inboxes");
    expect(b.textContent).toContain("no round yet");
  });

  test("inboxes the account could not read are named by number, not called removed, and Retry reads them again", async () => {
    monitors = [{ ...A }];
    let down = true;
    refuse = (method, path) =>
      down && method === "GET" && path === "/api/v1/chatwoot/inboxes"
        ? new Response(JSON.stringify({ error: "chatwoot down" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          })
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    const row = () => rowOf("Compradores").textContent ?? "";
    await waitFor(() => expect(row().includes("Inbox 1")).toBe(true));
    expect(row().includes("removed")).toBe(false);
    expect(
      (document.body.textContent ?? "").includes(
        "Could not read the account's inboxes",
      ),
    ).toBe(true);
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row().includes("Compras WhatsApp")).toBe(true));
    expect(
      (document.body.textContent ?? "").includes(
        "Could not read the account's inboxes",
      ),
    ).toBe(false);
  });

  test("an inbox read that fails on a later refresh says so too, instead of keeping the older names", async () => {
    monitors = [{ ...A }];
    let down = false;
    refuse = (method, path) =>
      down && method === "GET" && path === "/api/v1/chatwoot/inboxes"
        ? new Response(JSON.stringify({ error: "chatwoot down" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          })
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    await waitFor(() =>
      expect(
        (rowOf("Compradores").textContent ?? "").includes("Compras WhatsApp"),
      ).toBe(true),
    );
    down = true;
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Outra" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(
        (document.body.textContent ?? "").includes(
          "Could not read the account's inboxes",
        ),
      ).toBe(true),
    );
    expect((rowOf("Compradores").textContent ?? "").includes("Inbox 1")).toBe(
      true,
    );
  });

  test("New takes a name and the new monitor joins the list", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Linha nova" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await screen.findByText("Linha nova");
    expect(
      requests.some(
        (r) =>
          r.method === "POST" &&
          r.path === "/api/v1/occurrences/monitors" &&
          (r.body as { name: string }).name === "Linha nova",
      ),
    ).toBe(true);
  });

  test("Enter pressed again while the create is on the wire sends it once", async () => {
    monitors = [{ ...A }];
    let answer: () => void = () => {};
    createGate = new Promise((r) => {
      answer = r;
    });
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Linha nova" } });
    const posts = () =>
      requests.filter(
        (r) => r.method === "POST" && r.path === "/api/v1/occurrences/monitors",
      ).length;
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(posts()).toBe(1));
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    answer();
    await waitFor(() =>
      expect(screen.queryAllByText("Linha nova").length > 0).toBe(true),
    );
    expect(posts()).toBe(1);
  });

  test("an 11th monitor refused by the server says why in the form and stays out of the list", async () => {
    monitors = [{ ...A }];
    refuse = (method, path) =>
      method === "POST" && path === "/api/v1/occurrences/monitors"
        ? json({ error: "An account has at most 10 monitors." }, 422)
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Mais um" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(
      await within(dialog).findByText("An account has at most 10 monitors."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  test("a refusal that lands after the name was changed stays off the changed name", async () => {
    monitors = [{ ...A }];
    let answer: () => void = () => {};
    const held = new Promise<void>((r) => {
      answer = r;
    });
    refuse = (method, path) =>
      method === "POST" && path === "/api/v1/occurrences/monitors"
        ? held.then(() =>
            json({ error: "A monitor named Compradores already exists." }, 409),
          )
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Compradores" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === "POST" && r.path === "/api/v1/occurrences/monitors",
        ),
      ).toBe(true),
    );
    fireEvent.change(input, { target: { value: "Compradores 2" } });
    answer();
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole("button", { name: "Create" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await act(async () => {});
    expect((dialog.textContent ?? "").includes("already exists")).toBe(false);
  });

  test("the list has no rename, duplicate or delete control, and a row opens its monitor", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Produtores");
    for (const name of ["Rename", "Duplicate", "Delete"])
      expect(screen.queryByRole("button", { name }) === null).toBe(true);
    fireEvent.click(within(rowOf("Produtores")).getByRole("button"));
    await screen.findByRole("tab", { name: "Configuration" });
    expect(location).toBe("/resources/occurrences?monitor=2");
  });

  test("two quick renames keep the newest name, whichever list read lands last", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    await waitFor(() => expect(listAnswered).toBe(1));
    // The read after the first rename is held until the one after the second has landed.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const gates: (Promise<void> | null)[] = [held, null];
    listGate = () => gates.shift() ?? null;
    const rename = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
      fireEvent.change(screen.getByLabelText("Monitor name"), {
        target: { value: name },
      });
      fireEvent.submit(nameForm());
      await screen.findByRole("heading", { name });
    };
    await rename("Primeiro nome");
    await rename("Segundo nome");
    await waitFor(() => expect(listAnswered).toBe(2));
    release();
    await waitFor(() => expect(listAnswered).toBe(3));
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Segundo nome" })).toBeTruthy();
  });

  test("the name is edited in place in the monitor's header, and the header and the list show the new one", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    expect(screen.queryByRole("dialog") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Monitor name") as HTMLInputElement;
    expect(input.value).toBe("Produtores");
    fireEvent.change(input, { target: { value: "  Linha do produtor " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await screen.findByRole("heading", { name: "Linha do produtor" });
    expect(screen.queryByLabelText("Monitor name") === null).toBe(true);
    const patch = requests.filter(
      (r) =>
        r.method === "PATCH" && r.path === "/api/v1/occurrences/monitors/2",
    );
    expect(patch.length).toBe(1);
    expect((patch[0]?.body as { name: string } | undefined)?.name).toBe(
      "Linha do produtor",
    );
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    await screen.findByText("Linha do produtor");
    expect(screen.queryByText("Produtores") === null).toBe(true);
  });

  test("the header follows a name changed elsewhere once the list is read again", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    const ctx = await screen.findByLabelText("Business context");
    (monitors[0] as Monitor).name = "Renomeado por fora";
    fireEvent.change(ctx, { target: { value: "algo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Renomeado por fora" });
  });

  test("a name another monitor has is refused in the header, and the monitor keeps its name", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    refuse = (method, path) =>
      method === "PATCH" && path === "/api/v1/occurrences/monitors/2"
        ? json({ error: 'A monitor named "Compradores" already exists.' }, 409)
        : null;
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Monitor name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Compradores" } });
    fireEvent.click(within(nameForm()).getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already exists");
    expect(
      (screen.getByLabelText("Monitor name") as HTMLInputElement).value,
    ).toBe("Compradores");
    fireEvent.click(within(nameForm()).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Produtores" })).toBeTruthy();
    expect(monitors.find((m) => m.id === "2")?.name).toBe("Produtores");
  });

  test("the name cannot change while its save is on the wire, so a refusal is always about the name shown", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    let answer = () => {};
    const held = new Promise<void>((r) => {
      answer = r;
    });
    refuse = (method, path) =>
      method === "PATCH" && path === "/api/v1/occurrences/monitors/2"
        ? held.then(() =>
            json(
              { error: 'A monitor named "Compradores" already exists.' },
              409,
            ),
          )
        : null;
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Monitor name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Compradores" } });
    fireEvent.submit(nameForm());
    await waitFor(() => expect(input.readOnly).toBe(true));
    answer();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already exists");
    expect(input.value).toBe("Compradores");
    expect(input.readOnly).toBe(false);
  });

  test("Escape, Cancel and an unchanged name leave the name as it was without a request", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Monitor name"), {
      target: { value: "Outro" },
    });
    fireEvent.keyDown(screen.getByLabelText("Monitor name"), { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Produtores" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(
      (screen.getByLabelText("Monitor name") as HTMLInputElement).value,
    ).toBe("Produtores");
    fireEvent.change(screen.getByLabelText("Monitor name"), {
      target: { value: "Outro" },
    });
    fireEvent.click(within(nameForm()).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Produtores" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Monitor name"), {
      target: { value: "   " },
    });
    fireEvent.submit(nameForm());
    await act(async () => {});
    expect(screen.getByLabelText("Monitor name")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Monitor name"), {
      target: { value: "Produtores" },
    });
    fireEvent.click(within(nameForm()).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Monitor name") === null).toBe(true),
    );
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  test("Duplicate in the monitor's view asks for the copy's name, says what it carries, and opens the copy", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(input.value).toBe("Copy of Compradores");
    expect(dialog.textContent).toContain("configuration only");
    expect(dialog.textContent).toContain("no inboxes");
    expect(requests.some((r) => r.path.endsWith("/duplicate"))).toBe(false);
    fireEvent.change(input, { target: { value: "Compradores 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await screen.findByRole("heading", { name: "Compradores 2" });
    const dup = requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path === "/api/v1/occurrences/monitors/1/duplicate",
    );
    expect(dup.length).toBe(1);
    expect((dup[0]?.body as { name: string } | undefined)?.name).toBe(
      "Compradores 2",
    );
    const copy = monitors.find((m) => m.name === "Compradores 2");
    expect(location).toBe(`/resources/occurrences?monitor=${copy?.id}`);
    expect(screen.queryByRole("dialog") === null).toBe(true);
  });

  test("a copy's suggested name never passes the longest a monitor can have", async () => {
    monitors = [{ ...A, name: "x".repeat(80) }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(input.value.length).toBe(80);
    expect(input.value.startsWith("Copy of x")).toBe(true);
  });

  test("a copy's suggested name never ends on half of a character", async () => {
    // "Copy of " is 8 units: the emoji's two halves sit at 79 and 80, so the cap cuts between them.
    monitors = [{ ...A, name: `${"x".repeat(71)}😀 fim` }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(input.value).toBe(`Copy of ${"x".repeat(71)}`);
  });

  test("the copy opens only after the name form's Back trap has let go, so its cleanup pop cannot undo it", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    // The trap's cleanup pop is held: the browser has not answered history.back() yet.
    const pops: (() => void)[] = [];
    back.mockImplementation(() => {
      pops.push(() => window.dispatchEvent(new PopStateEvent("popstate")));
    });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(monitors.length).toBe(2));
    await waitFor(() => expect(listAnswered).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(pops.length).toBeGreaterThan(0));
    await act(async () => {});
    expect(location).toBe("/resources/occurrences?monitor=1");
    act(() => {
      for (const pop of pops.splice(0)) pop();
    });
    const copy = monitors.find((m) => m.id !== "1");
    await waitFor(() =>
      expect(location).toBe(`/resources/occurrences?monitor=${copy?.id}`),
    );
  });

  test("the copy opens from the server's answer even when the list read after it fails", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    let copied = false;
    refuse = (method, path) =>
      copied && method === "GET" && path === "/api/v1/occurrences/monitors"
        ? json({ error: "down" }, 500)
        : null;
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Cópia nova" },
    });
    copied = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await screen.findByRole("heading", { name: "Cópia nova" });
    const copy = monitors.find((m) => m.name === "Cópia nova");
    expect(location).toBe(`/resources/occurrences?monitor=${copy?.id}`);
    expect(screen.getByRole("tab", { name: "Configuration" })).toBeTruthy();
  });

  test("a copy that lands after the operator opened another monitor leaves them there", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    // The name form's cleanup pop is held while the operator goes to another monitor.
    const pops: (() => void)[] = [];
    back.mockImplementation(() => {
      pops.push(() => window.dispatchEvent(new PopStateEvent("popstate")));
    });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(monitors.length).toBe(3));
    await waitFor(() => expect(pops.length).toBeGreaterThan(0));
    act(() => navigateTo("/resources/occurrences?monitor=2"));
    await screen.findByRole("heading", { name: "Produtores" });
    act(() => {
      for (const pop of pops.splice(0)) pop();
    });
    await act(async () => {});
    expect(location).toBe("/resources/occurrences?monitor=2");
  });

  test("a delete that lands after the operator opened another monitor leaves them there", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    let answer = () => {};
    const held = new Promise<void>((r) => {
      answer = r;
    });
    refuse = (method, path) =>
      method === "DELETE" && path === "/api/v1/occurrences/monitors/1"
        ? held.then(() => {
            monitors = monitors.filter((m) => m.id !== "1");
            return json({
              instance: {},
              deleted: true,
              openThemes: 4,
              runs: 6,
            });
          })
        : null;
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(requests.some((r) => r.method === "DELETE")).toBe(true),
    );
    act(() => navigateTo("/resources/occurrences?monitor=2"));
    await screen.findByRole("heading", { name: "Produtores" });
    answer();
    await waitFor(() => expect(monitors.some((m) => m.id === "1")).toBe(false));
    await act(async () => {});
    expect(location).toBe("/resources/occurrences?monitor=2");
  });

  test("Cancel in the copy's name form creates nothing, and a refused copy says why in the form", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(requests.some((r) => r.path.endsWith("/duplicate"))).toBe(false);
    expect(monitors.length).toBe(1);
    refuse = (method, path) =>
      method === "POST" && path.endsWith("/duplicate")
        ? json({ error: "An account has at most 10 monitors." }, 422)
        : null;
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() =>
      expect(dialog.textContent).toContain("at most 10 monitors"),
    );
    expect(location).toBe("/resources/occurrences?monitor=1");
  });

  test("a copy made with an unsaved edit asks before opening it, and Keep editing keeps the edit and lists the copy", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    const discard = await screen.findByRole("button", {
      name: /Keep editing/,
    });
    expect(monitors.length).toBe(2);
    fireEvent.click(discard);
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(location).toBe("/resources/occurrences?monitor=1");
    expect(
      (screen.getByLabelText("Business context") as HTMLTextAreaElement).value,
    ).toBe("rascunho");
  });

  test("a name typed and not saved is an unsaved edit: leaving asks first, Keep editing keeps it, and a saved or unchanged name does not ask", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    await screen.findByText("Compradores");
    fireEvent.click(within(rowOf("Produtores")).getByRole("button"));
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Monitor name"), {
      target: { value: "Rascunho de nome" },
    });
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Discard changes?") === null).toBe(true),
    );
    expect(
      (screen.getByLabelText("Monitor name") as HTMLInputElement).value,
    ).toBe("Rascunho de nome");
    expect(location).toBe("/resources/occurrences?monitor=2");
    fireEvent.submit(nameForm());
    await screen.findByRole("heading", { name: "Rascunho de nome" });
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    await screen.findByText("Compradores");
    expect(screen.queryByText("Discard changes?") === null).toBe(true);
  });

  test("a copy that lands after the operator left the page does not bring them back", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    render(
      <MemoryRouter initialEntries={["/resources/occurrences?monitor=1"]}>
        <NavGuardProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/resources/occurrences"
                element={<OccurrencesPanel />}
              />
              <Route path="/agents" element={<p>Agentes</p>} />
            </Routes>
            <LocationProbe />
          </ToastProvider>
        </NavGuardProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dialog = await screen.findByRole("dialog");
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const gates: (Promise<void> | null)[] = [held];
    listGate = () => gates.shift() ?? null;
    const pops: (() => void)[] = [];
    back.mockImplementation(() => {
      pops.push(() => window.dispatchEvent(new PopStateEvent("popstate")));
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(monitors.length).toBe(2));
    await waitFor(() => expect(pops.length).toBeGreaterThan(0));
    act(() => navigateTo("/agents"));
    await screen.findByText("Agentes");
    act(() => {
      for (const pop of pops.splice(0)) pop();
    });
    release();
    await waitFor(() => expect(listAnswered).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    expect(location).toBe("/agents");
  });

  test("going back to the list with an unsaved edit asks first, and Keep editing keeps the edit", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Discard changes?") === null).toBe(true),
    );
    expect(
      (screen.getByLabelText("Business context") as HTMLTextAreaElement).value,
    ).toBe("rascunho");
    expect(location).toBe("/resources/occurrences?monitor=2");
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await screen.findByText("Compradores");
    expect(location).toBe("/resources/occurrences");
  });

  test("browser Back with an unsaved edit asks before leaving the monitor", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    // Back pops the guard's sentinel entry; the guard asks instead of letting the page go.
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect((await screen.findByText("Discard changes?")) !== null).toBe(true);
    expect(location).toBe("/resources/occurrences?monitor=2");
  });

  test("a tab change is no history entry: with an unsaved edit, browser Back asks and Discard leaves the monitor, even after tabs seen before the edit", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    // The real browser history this time: Back pops entries, Discard traverses them.
    back.mockRestore();
    const happy = (globalThis as { happyDOM?: { setURL(u: string): void } })
      .happyDOM;
    happy?.setURL("http://localhost/resources/occurrences");
    window.history.replaceState(null, "");
    window.history.pushState({ idx: 1 }, "", "?monitor=2");
    render(
      <BrowserRouter>
        <NavGuardProvider>
          <ToastProvider>
            <OccurrencesPanel />
          </ToastProvider>
        </NavGuardProvider>
      </BrowserRouter>,
    );
    const selected = () =>
      document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent ?? "";
    const ctx = await screen.findByLabelText("Business context");
    const entries = window.history.length;
    // Clean: the URL follows the tab in place.
    fireEvent.click(screen.getByRole("tab", { name: "Themes" }));
    await waitFor(() =>
      expect(window.location.search).toBe("?monitor=2&tab=themes"),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    await waitFor(() =>
      expect(window.location.search).toBe("?monitor=2&tab=config"),
    );
    expect(window.history.length).toBe(entries);
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Rounds" }));
    expect(selected()).toBe("Rounds");
    window.history.back();
    expect((await screen.findByText("Discard changes?")) !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(screen.queryByText("Discard changes?") === null).toBe(true),
    );
    expect(selected()).toBe("Rounds");
    expect(
      (screen.getByLabelText("Business context") as HTMLTextAreaElement).value,
    ).toBe("rascunho");
    window.history.back();
    expect((await screen.findByText("Discard changes?")) !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    await waitFor(() =>
      expect(screen.queryByLabelText("Business context") === null).toBe(true),
    );
    expect(screen.queryAllByText("Compradores").length > 0).toBe(true);
    // afterEach restores the spy it set; this test already did.
    back = spyOn(window.history, "back");
  });

  test("with an unsaved edit the URL keeps the tab it had, past the guard's wait for its sentinel", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2&tab=config");
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    jest.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("tab", { name: "Rounds" }));
      jest.advanceTimersByTime(5_000);
    } finally {
      jest.useRealTimers();
    }
    await act(async () => {});
    expect(location).toBe("/resources/occurrences?monitor=2&tab=config");
  });

  test("with only a typed name unsaved the URL keeps the tab it had too, past the guard's wait for its sentinel", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2&tab=config");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Monitor name"), {
      target: { value: "Rascunho de nome" },
    });
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    jest.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("tab", { name: "Rounds" }));
      jest.advanceTimersByTime(5_000);
    } finally {
      jest.useRealTimers();
    }
    await act(async () => {});
    expect(location).toBe("/resources/occurrences?monitor=2&tab=config");
    expect(
      (window.history.state as Record<string, unknown> | null)?.[
        "__unsavedBackGuard"
      ],
    ).toBe(true);
  });

  test("a link to another tab of the open monitor opens it and the URL stays put", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2&tab=config");
    await screen.findByLabelText("Business context");
    act(() => navigateTo("/resources/occurrences?monitor=2&tab=rounds"));
    const selected = () =>
      document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent ?? "";
    await waitFor(() => expect(selected()).toBe("Rounds"));
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await act(async () => {});
      seen.add(location);
    }
    expect([...seen].join(" ")).toBe(
      "/resources/occurrences?monitor=2&tab=rounds",
    );
    expect(selected()).toBe("Rounds");
  });

  test("Discard from All monitors leaves no dead copy of the monitor behind: one Back opens it, the next one leaves it", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    back.mockRestore();
    (globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
      "http://localhost/resources/occurrences",
    );
    window.history.replaceState(null, "");
    window.history.pushState({ idx: 1 }, "", "?monitor=2");
    render(
      <BrowserRouter>
        <NavGuardProvider>
          <ToastProvider>
            <OccurrencesPanel />
          </ToastProvider>
        </NavGuardProvider>
      </BrowserRouter>,
    );
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Discard",
      }),
    );
    await waitFor(() => expect(window.location.search).toBe(""));
    await screen.findByText("Compradores");
    window.history.back();
    await waitFor(() => expect(window.location.search).toBe("?monitor=2"));
    await screen.findByLabelText("Business context");
    window.history.back();
    await waitFor(() => expect(window.location.search).toBe(""));
    back = spyOn(window.history, "back");
  });

  test("a monitor with nothing yet says so in the delete confirmation instead of zero counts", async () => {
    monitors = [{ ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("no themes or rounds yet");
    expect(dialog.textContent?.includes("0 open themes")).toBe(false);
  });

  test("Delete in the monitor's view asks with the counts as they are now; Cancel keeps it, Delete lands on the list without it", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    // A round ran after the list was read: the confirmation says what is there now.
    const a = monitors.find((m) => m.id === "1") as Monitor;
    a.openThemes = 5;
    a.runs = 7;
    const del = () =>
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    del();
    let dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("5 open themes");
    expect(dialog.textContent).toContain("7 rounds");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(location).toBe("/resources/occurrences?monitor=1");
    del();
    dialog = await screen.findByRole("dialog");
    // The list read after the delete is held: the deleted monitor is gone from the list already.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    listGate = () => held;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByText("Produtores");
    await waitFor(() => expect(location).toBe("/resources/occurrences"));
    expect(screen.queryByText("Compradores") === null).toBe(true);
    listGate = null;
    release();
    expect(
      requests.some(
        (r) =>
          r.method === "DELETE" && r.path === "/api/v1/occurrences/monitors/1",
      ),
    ).toBe(true);
  });

  test("a refused delete keeps the confirmation open and the monitor in place", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    refuse = (method) =>
      method === "DELETE" ? json({ error: "nope" }, 500) : null;
    renderPanel("/resources/occurrences?monitor=1");
    await screen.findByRole("tab", { name: "Configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(requests.some((r) => r.method === "DELETE")).toBe(true),
    );
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(location).toBe("/resources/occurrences?monitor=1");
  });

  test("opening a monitor shows its tabs and reads its own configuration, and Back returns to the list", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel();
    fireEvent.click(await screen.findByText("Produtores"));
    await screen.findByRole("tab", { name: "Configuration" });
    expect(screen.getByRole("tab", { name: "Themes" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Rounds" })).toBeTruthy();
    expect(location).toBe("/resources/occurrences?monitor=2");
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === "GET" &&
            r.path === "/api/v1/occurrences/monitors/2/config",
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    await screen.findByText("Compradores");
    expect(location).toBe("/resources/occurrences");
  });

  test("an inbox another monitor also reads says which, and one only this monitor reads does not", async () => {
    monitors = [{ ...A }, { ...B, inboxIds: ["1", "3"] }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    const shared = await screen.findByText("also read by Compradores");
    const chip = shared.closest("span")?.parentElement as HTMLElement;
    expect(chip.textContent).toContain("Compras WhatsApp");
    const other = screen
      .getAllByText("Produtores WhatsApp")
      .map((el) => el.parentElement?.textContent ?? "");
    expect(other.some((t) => t.includes("also read by"))).toBe(false);
  });

  test("a save the server refuses for another monitor's attribute names it on the page", async () => {
    monitors = [{ ...A }, { ...B, inboxIds: ["3"] }];
    refuse = (method, path) =>
      method === "PUT" && path === "/api/v1/occurrences/monitors/2/config"
        ? json(
            {
              error:
                "The monitor Compradores already writes the Chatwoot attribute evento on the inbox Compras WhatsApp.",
            },
            422,
          )
        : null;
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "algo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Compradores");
  });
});
