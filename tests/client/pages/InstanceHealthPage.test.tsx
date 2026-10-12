/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import * as AuthModule from "@/client/contexts/AuthContext";
import { stubExports } from "@/tests/utils/module-stub";

// The instance health screen keeps polling; a poll that fails after a good read must say the cards
// are old instead of showing them as current. Assertions reduce to strings and booleans first: a
// failing expectation holding a DOM node stalls the runner.
stubExports(AuthModule, {
  useAuth: () => ({
    user: { id: "1", email: "admin@fazer.ai", role: "SUPER_ADMIN" },
    loading: false,
    logout: async () => {},
  }),
});

const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { InstanceHealthPage } = await import(
  "@/client/pages/admin/instance-health/InstanceHealthPage"
);

const realFetch = globalThis.fetch;

// The pool and lane cards, only for the test that reads their detail line.
const EXTRA = {
  schedulerKinds: { FOLLOWUP: 60_000, HEARTBEAT: 428_649, DEBOUNCE: 1_000 },
  pools: { main: { inUse: 30, idle: 0, waiting: 4, oldestWaitMs: 1_500 } },
  signals: [
    {
      signal: "pool_waiters:main",
      unit: "count",
      value: 4,
      at: new Date().toISOString(),
      threshold: 0,
      durationSeconds: 30,
      enabled: true,
      firing: false,
      stale: false,
      history: [{ at: Date.now(), value: 4 }],
    },
    {
      signal: "lock_timeouts_per_min",
      unit: "per_minute",
      value: 2,
      at: new Date().toISOString(),
      threshold: 0,
      durationSeconds: 0,
      enabled: true,
      firing: true,
      stale: false,
      history: [{ at: Date.now(), value: 2 }],
    },
    {
      signal: "scheduler_queue_age_ms:shared",
      unit: "ms",
      value: 428_649,
      at: new Date().toISOString(),
      threshold: 300_000,
      durationSeconds: 0,
      enabled: true,
      firing: true,
      stale: false,
      history: [{ at: Date.now(), value: 428_649 }],
    },
  ],
};
let withExtra = false;
// The shared lane as a database half failing since boot leaves it: no value, no kinds.
let laneNeverRead = false;
let healthOk = true;
let channelFailing = false;
let signalStale = false;
let releaseSave: (() => void) | null = null;
let channelsOk = true;
let channelReads = 0;
let channelPending = false;
let healthReads = 0;
let slowChannels: { release: () => void; done: boolean } | null = null;
let slowHealth: { release: () => void; done: boolean } | null = null;
let channelType = "webhook";
let channelSecret = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const HEALTH = {
  instance: { id: "i", edition: "free" },
  health: {
    sampleIntervalMs: 5000,
    historyMs: 3_600_000,
    sampling: true,
    schedulerKinds: {},
    pools: {},
    signals: [
      {
        signal: "event_loop_p99_ms",
        unit: "ms",
        value: 12,
        at: new Date().toISOString(),
        threshold: 200,
        durationSeconds: 30,
        enabled: true,
        firing: false,
        history: [{ at: Date.now(), value: 12 }],
      },
    ],
  },
};

beforeEach(() => {
  healthOk = true;
  channelFailing = false;
  signalStale = false;
  releaseSave = null;
  channelsOk = true;
  channelReads = 0;
  channelPending = false;
  withExtra = false;
  laneNeverRead = false;
  healthReads = 0;
  slowChannels = null;
  slowHealth = null;
  channelType = "webhook";
  channelSecret = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.pathname.startsWith("/api/v1/instance-health/thresholds/")) {
      if (method === "PUT") {
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
      }
      return json({ signal: "event_loop_p99_ms", threshold: 300 });
    }
    if (url.pathname === "/api/v1/instance-health") {
      if (!healthOk) return json({ error: "down" }, 500);
      healthReads++;
      let value = 12;
      if (slowHealth && healthReads === 2) {
        // The first poll: held back, then answered with what was true when it was asked.
        const gate = slowHealth;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        value = 999;
        gate.done = true;
      } else if (slowHealth && healthReads > 2) {
        value = 50;
      }
      const signals = HEALTH.health.signals.map((s) => ({
        ...s,
        value,
        stale: signalStale,
      }));
      if (withExtra) {
        return json({
          ...HEALTH,
          health: {
            ...HEALTH.health,
            schedulerKinds: laneNeverRead ? {} : EXTRA.schedulerKinds,
            pools: EXTRA.pools,
            signals: [...signals, ...EXTRA.signals].map((x) =>
              laneNeverRead && x.signal === "scheduler_queue_age_ms:shared"
                ? { ...x, value: null, at: null, stale: true, history: [] }
                : x,
            ),
          },
        });
      }
      return json({ ...HEALTH, health: { ...HEALTH.health, signals } });
    }
    if (url.pathname === "/api/v1/instance-health/channels") {
      channelReads++;
      if (!channelsOk) return json({ error: "down" }, 500);
      let name = "ops";
      if (slowChannels && channelReads === 2) {
        const gate = slowChannels;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        name = "stale ops";
        gate.done = true;
      } else if (slowChannels && channelReads > 2) {
        name = "new ops";
      }
      return json({
        instance: HEALTH.instance,
        channels: [
          {
            id: "1",
            name,
            type: channelType,
            urlMasked: channelPending ? null : "https://hooks.example/…",
            // A channel waiting for its URL is created switched off.
            enabled: !channelPending,
            signals: [],
            hasSecret: channelSecret,
            unsignedReason: null,
            failing: channelFailing
              ? {
                  at: new Date().toISOString(),
                  error: "HTTP 500",
                  signal: "event_loop_p99_ms",
                }
              : null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      });
    }
    return json({}, 404);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("instance health screen", () => {
  test("a failed refresh marks the cards as old, and a good one clears it (catches stale figures shown as current)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("12 ms");
    expect(Boolean(screen.queryByText(/Could not refresh since/))).toBe(false);
    healthOk = false;
    await waitFor(() => {
      expect(Boolean(screen.queryByText(/Could not refresh since/))).toBe(true);
    });
    expect(Boolean(screen.queryByText("12 ms"))).toBe(true);
    healthOk = true;
    await waitFor(() => {
      expect(Boolean(screen.queryByText(/Could not refresh since/))).toBe(
        false,
      );
    });
  });

  test("a signal the server marks stale says so on its card, even while the request succeeds (catches an old reading shown as current)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("12 ms");
    expect(Boolean(screen.queryByText(/Not updated since/))).toBe(false);
    signalStale = true;
    await waitFor(() => {
      expect(Boolean(screen.queryByText(/Not updated since/))).toBe(true);
    });
    expect(Boolean(screen.queryByText(/Could not refresh since/))).toBe(false);
  });

  test("a dialog stays open while its save is in flight (catches a late save closing the dialog opened after it)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByLabelText("Edit threshold"));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(releaseSave === null).toBe(false);
    });
    // fireEvent runs inside act: a dismissal it triggered has already rendered.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(Boolean(screen.queryByRole("dialog"))).toBe(true);
    releaseSave?.();
    await waitFor(() => {
      expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    });
  });

  test("a channel list that failed to load comes back on the next good poll (catches an error screen that never clears)", async () => {
    channelsOk = false;
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("12 ms");
    // Two failed reads: the first load and at least one poll after it.
    await waitFor(() => {
      expect(channelReads >= 2).toBe(true);
    });
    expect(Boolean(screen.queryByText("ops"))).toBe(false);
    channelsOk = true;
    await waitFor(() => {
      expect(Boolean(screen.queryByText("ops"))).toBe(true);
    });
  });

  test("only a webhook with a secret reads as signed (catches a Discord channel claimed as signed)", async () => {
    channelSecret = true;
    channelType = "discord";
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("ops");
    expect(Boolean(screen.queryByText(/Signed/))).toBe(false);
    channelType = "webhook";
    await waitFor(() => {
      expect(Boolean(screen.queryByText(/Signed/))).toBe(true);
    });
  });

  test("a channel refresh that fails after a good load says the status is old, and a good one clears it (catches a failing channel shown as healthy)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("ops");
    channelsOk = false;
    await waitFor(() => {
      expect(
        Boolean(screen.queryByText(/Could not refresh the channels since/)),
      ).toBe(true);
    });
    // The health request still succeeds: only the channel list is old.
    expect(Boolean(screen.queryByText(/Could not refresh since/))).toBe(false);
    channelsOk = true;
    await waitFor(() => {
      expect(
        Boolean(screen.queryByText(/Could not refresh the channels since/)),
      ).toBe(false);
    });
  });

  test("a slow poll that answers after a newer one is dropped (catches an old read overwriting the cards)", async () => {
    slowHealth = { release: () => {}, done: false };
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("50 ms");
    const gate = slowHealth as { release: () => void; done: boolean };
    gate.release();
    await waitFor(() => {
      expect(gate.done).toBe(true);
    });
    await act(async () => {});
    expect(Boolean(screen.queryByText("999 ms"))).toBe(false);
  });

  test("a slow channel poll that answers after a newer one is dropped (catches pre-save data overwriting the list)", async () => {
    slowChannels = { release: () => {}, done: false };
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("new ops");
    const gate = slowChannels as { release: () => void; done: boolean };
    gate.release();
    await waitFor(() => {
      expect(gate.done).toBe(true);
    });
    await act(async () => {});
    expect(Boolean(screen.queryByText("stale ops"))).toBe(false);
  });

  test("a fractional threshold can be saved from the dialog (catches the form refusing a value REST accepts)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByLabelText("Edit threshold"));
    const input = (await screen.findByLabelText(
      /Alert when above/,
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "200.5" } });
    expect(input.checkValidity()).toBe(true);
  });

  test("the link a tool hands back opens the waiting channel's dialog, which asks for its URL (catches a fillAt link that lands nowhere)", async () => {
    channelPending = true;
    render(
      <MemoryRouter initialEntries={["/admin/instance-health?fill=1"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent?.includes("Edit instance alert channel")).toBe(
      true,
    );
    // No URL yet: saving needs one, and "leave blank to keep" does not apply.
    expect(
      Boolean(screen.queryByText("Leave blank to keep the current URL.")),
    ).toBe(false);
    expect(Boolean(screen.queryAllByText("Waiting for its URL").length)).toBe(
      true,
    );
    // Filling the URL is the moment to turn it on, so the dialog opens switched on.
    const inDialog = within(dialog);
    expect(inDialog.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    const save = inDialog.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(inDialog.getByPlaceholderText("https://"), {
      target: { value: "https://hooks.example/ops" },
    });
    expect(save.disabled).toBe(false);
  });

  test("a channel waiting for its URL cannot be switched on or tested from its row (catches controls that only fail after a click)", async () => {
    channelPending = true;
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findAllByText("Waiting for its URL");
    const toggle = screen.getByRole("switch", { name: "Enabled" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    const test = screen.getByRole("button", { name: "Test" });
    expect((test as HTMLButtonElement).disabled).toBe(true);
  });

  test("a link that arrives while the channel list cannot be read waits for it instead of reporting the channel gone (catches a fillAt link consumed by a failed load)", async () => {
    channelPending = true;
    channelsOk = false;
    render(
      <MemoryRouter initialEntries={["/admin/instance-health?fill=1"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(channelReads).toBeGreaterThanOrEqual(2);
    });
    expect(
      Boolean(screen.queryByText("That alert channel no longer exists")),
    ).toBe(false);
    channelsOk = true;
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent?.includes("Edit instance alert channel")).toBe(
      true,
    );
  });

  test("a link to a channel that no longer exists says so (catches a fillAt link that silently does nothing)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health?fill=999"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("That alert channel no longer exists");
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
  });

  test("a pool card shows its connections and a lane card its overdue kinds (catches waiters with no context)", async () => {
    withExtra = true;
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("30 in use · 0 idle · oldest wait 1.5 s");
    // HEARTBEAT and FOLLOWUP are shared-lane kinds, the oldest first; DEBOUNCE belongs to another
    // lane and is not listed here.
    expect(
      Boolean(screen.queryByText(/^HEARTBEAT 7\.1 min · FOLLOWUP \S+ min$/)),
    ).toBe(true);
    expect(Boolean(screen.queryByText(/DEBOUNCE/))).toBe(false);
  });

  test("a rate's threshold is labelled per minute, not in milliseconds (catches an editor that misstates what the number controls)", async () => {
    withExtra = true;
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    let card: HTMLElement | null = await screen.findByText("Lock timeouts");
    while (card && !within(card).queryByLabelText("Edit threshold")) {
      card = card.parentElement;
    }
    if (!card) throw new Error("no card around the lock timeouts signal");
    fireEvent.click(within(card).getByLabelText("Edit threshold"));
    await screen.findByLabelText("Alert when above (per minute)");
  });

  test("a lane never read says nothing about its jobs (catches 'no job overdue' with no reading behind it)", async () => {
    withExtra = true;
    laneNeverRead = true;
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("30 in use · 0 idle · oldest wait 1.5 s");
    expect(Boolean(screen.queryByText("No job overdue"))).toBe(false);
    expect(Boolean(screen.queryByText(/^HEARTBEAT/))).toBe(false);
  });

  test("a negative threshold is refused on the field, not only by a disabled Save (catches a refusal the operator cannot read)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByLabelText("Edit threshold"));
    const input = (await screen.findByLabelText(
      /Alert when above/,
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-5" } });
    expect(
      Boolean(
        screen.queryByText("The threshold must be a number of zero or more."),
      ),
    ).toBe(true);
    fireEvent.change(await screen.findByLabelText(/For at least/), {
      target: { value: "5000" },
    });
    expect(
      Boolean(
        screen.queryByText(
          "The duration must be a whole number of seconds, from 0 to 3600.",
        ),
      ),
    ).toBe(true);
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test("a channel's delivery failure shows while the screen is open (catches a failure visible only after a reload)", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/instance-health"]}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <NavGuardProvider>
                <InstanceHealthPage pollMs={20} />
              </NavGuardProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("ops");
    expect(Boolean(screen.queryByText(/was not delivered/))).toBe(false);
    channelFailing = true;
    await waitFor(() => {
      expect(Boolean(screen.queryByText(/was not delivered/))).toBe(true);
    });
  });
});
