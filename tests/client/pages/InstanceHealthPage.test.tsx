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
// One kind deleted on DONE, with its three signals and its reading.
let withKind = false;
let puts: { path: string; body: unknown }[] = [];
const kindSignal = (
  signal: string,
  unit: string,
  value: number,
  threshold: number,
  enabled: boolean,
) => ({
  signal,
  unit,
  value,
  at: new Date().toISOString(),
  threshold,
  durationSeconds: 0,
  enabled,
  firing: false,
  stale: false,
  history: [{ at: Date.now(), value }],
});
type KindReading = {
  donePerMin: number;
  failedPerMin: number;
  oldestDueMs: number | null;
  stalledMs: number | null;
  state: string;
};
const DRAINING: KindReading = {
  donePerMin: 12,
  failedPerMin: 3,
  oldestDueMs: 480_000,
  stalledMs: 10_000,
  state: "draining",
};
let kindReading = DRAINING;
// The failure rate turned on and firing while the stall is muted.
let kindRateFiring = false;
let kindStallStale = false;
const KIND = {
  signals: [
    kindSignal(
      "scheduler_done_per_min:DELIVERY_RECOVERY",
      "per_minute",
      12,
      0,
      false,
    ),
    kindSignal(
      "scheduler_failed_per_min:DELIVERY_RECOVERY",
      "per_minute",
      3,
      7,
      false,
    ),
    kindSignal(
      "scheduler_stalled_ms:DELIVERY_RECOVERY",
      "ms",
      10_000,
      300_000,
      true,
    ),
  ],
};
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
// The event loop card's history, when a test needs one with a shape: a reading back at 0 after a
// spike, over the span the samples cover.
let spikeMinutes: number | null = null;
let historyMs = 3_600_000;

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
  withKind = false;
  kindReading = DRAINING;
  kindRateFiring = false;
  kindStallStale = false;
  puts = [];
  laneNeverRead = false;
  healthReads = 0;
  slowChannels = null;
  slowHealth = null;
  channelType = "webhook";
  channelSecret = false;
  spikeMinutes = null;
  historyMs = 3_600_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.pathname.startsWith("/api/v1/instance-health/thresholds/")) {
      if (method === "PUT") {
        const body =
          input instanceof Request ? await input.clone().text() : init?.body;
        puts.push({
          path: url.pathname,
          body: JSON.parse(String(body ?? "null")),
        });
        if (withKind) return json({ signal: url.pathname, threshold: 9 });
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
      const spike = spikeMinutes;
      const signals = HEALTH.health.signals.map((s) =>
        spike === null
          ? { ...s, value, stale: signalStale }
          : {
              ...s,
              value: 0,
              stale: signalStale,
              history: [0, 4_200, 0].map((v, i) => ({
                at: Date.now() - ((2 - i) * spike * 60_000) / 2,
                value: v,
              })),
            },
      );
      if (withKind) {
        return json({
          ...HEALTH,
          health: {
            ...HEALTH.health,
            schedulerKinds: { DELIVERY_RECOVERY: 480_000 },
            schedulerThroughput: { DELIVERY_RECOVERY: kindReading },
            signals: [
              ...signals,
              ...KIND.signals.map((k) =>
                !kindRateFiring
                  ? k
                  : k.signal.startsWith("scheduler_failed_per_min:")
                    ? { ...k, enabled: true, firing: true }
                    : k.signal.startsWith("scheduler_stalled_ms:")
                      ? { ...k, enabled: false, stale: kindStallStale }
                      : k,
              ),
            ],
          },
        });
      }
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
      return json({
        ...HEALTH,
        health: { ...HEALTH.health, historyMs, signals },
      });
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
    // And Save sends the fraction as typed, not a rounded number.
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]?.body).toMatchObject({ threshold: 200.5 });
    (releaseSave as (() => void) | null)?.();
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

  test("a card back at 0 after a spike states the window and its peak (catches a curve with no scale read as contradicting the value)", async () => {
    spikeMinutes = 60;
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
    await screen.findByText("0 ms");
    expect(Boolean(screen.queryByText("Last hour"))).toBe(true);
    expect(Boolean(screen.queryByText("Peak 4.2 s"))).toBe(true);
  });

  test("the window named under the curve is the one the server keeps, not the span of the samples (catches twenty minutes after a restart named as the window)", async () => {
    spikeMinutes = 20;
    historyMs = 30 * 60_000;
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
    await screen.findByText("Last 30 min");
    expect(Boolean(screen.queryByText("Last 20 min"))).toBe(false);
    expect(Boolean(screen.queryByText("Peak 4.2 s"))).toBe(true);
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

  test("a kind deleted on DONE is one card: its stall, with its rates and reading beside it, and its dialog edits each of the three (catches a slow queue and a stuck one looking the same)", async () => {
    withKind = true;
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
    await screen.findByText(
      "12/min completed · 3/min failed · oldest due 8.0 min · draining",
    );
    expect(
      Boolean(screen.queryByText("DELIVERY_RECOVERY: no progress for")),
    ).toBe(true);
    // The same card reads the other two states the server sends.
    kindReading = {
      donePerMin: 0,
      failedPerMin: 3,
      oldestDueMs: 480_000,
      stalledMs: 480_000,
      state: "stuck",
    };
    await screen.findByText(
      "0/min completed · 3/min failed · oldest due 8.0 min · stuck",
    );
    kindReading = {
      donePerMin: 0,
      failedPerMin: 0,
      oldestDueMs: null,
      stalledMs: 0,
      state: "idle",
    };
    await screen.findByText("0/min completed · 0/min failed · nothing due");
    // Never read from the database: the in-process rates still show, the rest waits for a reading.
    kindReading = {
      donePerMin: 5,
      failedPerMin: 1,
      oldestDueMs: null,
      stalledMs: null,
      state: "unknown",
    };
    await screen.findByText("5/min completed · 1/min failed");
    // The rates ride on that card, not on cards of their own.
    expect(
      Boolean(screen.queryByText("DELIVERY_RECOVERY: completed per minute")),
    ).toBe(false);
    let card: HTMLElement | null = screen.getByText(
      "DELIVERY_RECOVERY: no progress for",
    );
    while (card && !within(card).queryByLabelText("Edit threshold")) {
      card = card.parentElement;
    }
    if (!card) throw new Error("no card around the kind");
    fireEvent.click(within(card).getByLabelText("Edit threshold"));
    await screen.findByText("Thresholds: DELIVERY_RECOVERY");
    const field = () =>
      screen.getByLabelText(/Alert when above/) as HTMLInputElement;
    expect([field().value, field().labels?.[0]?.textContent]).toEqual([
      "300000",
      "Alert when above (milliseconds)",
    ]);
    fireEvent.click(screen.getByLabelText("Failed"));
    await waitFor(() => expect(field().value).toBe("7"));
    expect(field().labels?.[0]?.textContent).toBe(
      "Alert when above (per minute)",
    );
    const sw = screen.getByLabelText("Alert on this signal");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.change(field(), { target: { value: "9" } });
    fireEvent.click(sw);
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({
      path: "/api/v1/instance-health/thresholds/scheduler_failed_per_min:DELIVERY_RECOVERY",
      body: { threshold: 9, durationSeconds: 0, enabled: true },
    });
  });

  test("a kind's card says which of its rates is firing, and is not 'not alerting' while one is on (catches a rate paging from a card that looks quiet)", async () => {
    withKind = true;
    kindRateFiring = true;
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
    await screen.findByText("Failed above threshold");
    expect(Boolean(screen.queryByText("Not alerting"))).toBe(false);
    // The stall's database read goes stale; the rate is counted in process and is still firing.
    kindStallStale = true;
    await screen.findByText(/^Not updated since/);
    expect(Boolean(screen.queryByText("Failed above threshold"))).toBe(true);
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
