import { beforeEach, describe, expect, test } from "bun:test";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import {
  ceilingFor,
  decideSpend,
  monthEnd,
  monthStart,
} from "@/modules/spend-ceiling/decide";
import {
  announceSpendCeilingOnConversation,
  clearSpendCeilingFlights,
} from "@/modules/spend-ceiling/notice";
import { spendCeilingAnnouncement } from "@/modules/spend-ceiling/service";
import {
  readSpendCeilingConfig,
  SPEND_CEILING_DEFAULTS,
  SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS,
  SPEND_CEILING_TOKENS_MAX,
  type SpendCeilingConfig,
  spendCeilingSettingsSchema,
} from "@/modules/spend-ceiling/settings";

// The RULE, proved without a database. What the ledger says and what the operator is shown are
// fiation; this is the decision itself (issue #146).

function cfg(patch: Partial<SpendCeilingConfig> = {}): SpendCeilingConfig {
  return { ...SPEND_CEILING_DEFAULTS, ...patch };
}

describe("the spend ceiling decision", () => {
  // Every row an operator can actually configure, against every state the ledger can be in.
  const table: Array<{
    name: string;
    cfg: Partial<SpendCeilingConfig>;
    source: "inbox" | "playground";
    used: number;
    expect: "allowed" | "warning" | "over";
  }> = [
    {
      name: "switched off, and far past a number that is set",
      cfg: { enabled: false, monthlyInboxTokens: 100 },
      source: "inbox",
      used: 1_000_000,
      expect: "allowed",
    },
    {
      name: "on, with no number on this half",
      cfg: { enabled: true, monthlyInboxTokens: 0 },
      source: "inbox",
      used: 1_000_000,
      expect: "allowed",
    },
    {
      name: "on, under both the ceiling and the warning",
      cfg: { enabled: true, monthlyInboxTokens: 1000, warnAtPercent: 80 },
      source: "inbox",
      used: 799,
      expect: "allowed",
    },
    {
      name: "exactly at the warning fraction",
      cfg: { enabled: true, monthlyInboxTokens: 1000, warnAtPercent: 80 },
      source: "inbox",
      used: 800,
      expect: "warning",
    },
    {
      name: "one token short of the ceiling",
      cfg: { enabled: true, monthlyInboxTokens: 1000 },
      source: "inbox",
      used: 999,
      expect: "warning",
    },
    {
      name: "exactly at the ceiling",
      cfg: { enabled: true, monthlyInboxTokens: 1000 },
      source: "inbox",
      used: 1000,
      expect: "over",
    },
    {
      name: "past the ceiling",
      cfg: { enabled: true, monthlyInboxTokens: 1000 },
      source: "inbox",
      used: 4000,
      expect: "over",
    },
    {
      name: "warning switched off leaves the run allowed right up to the ceiling",
      cfg: { enabled: true, monthlyInboxTokens: 1000, warnAtPercent: 0 },
      source: "inbox",
      used: 999,
      expect: "allowed",
    },
    // The two halves, and the point of them being two.
    {
      name: "the playground is over its own ceiling",
      cfg: {
        enabled: true,
        monthlyInboxTokens: 1_000_000,
        monthlyPlaygroundTokens: 100,
      },
      source: "playground",
      used: 500,
      expect: "over",
    },
    {
      name: "and the same usage leaves customer traffic answering",
      cfg: {
        enabled: true,
        monthlyInboxTokens: 1_000_000,
        monthlyPlaygroundTokens: 100,
      },
      source: "inbox",
      used: 500,
      expect: "allowed",
    },
    {
      name: "a playground ceiling alone does not bound the inbox",
      cfg: {
        enabled: true,
        monthlyInboxTokens: 0,
        monthlyPlaygroundTokens: 100,
      },
      source: "inbox",
      used: 10_000_000,
      expect: "allowed",
    },
  ];

  test.each(table.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const verdict = decideSpend({
      cfg: cfg(row.cfg),
      source: row.source,
      usedTokens: row.used,
    });
    expect(verdict.state).toBe(row.expect);
  });

  // The number travels with the verdict, because everything downstream reports it: the flow line,
  // the operator note, and the alert that fires before the agent goes quiet.
  test("the verdict carries what was used and what the ceiling was", () => {
    const v = decideSpend({
      cfg: cfg({ enabled: true, monthlyInboxTokens: 1000 }),
      source: "inbox",
      usedTokens: 1200,
    });
    expect(v).toEqual({ state: "over", usedTokens: 1200, ceilingTokens: 1000 });
  });

  test("zero is no ceiling, on either half", () => {
    const c = cfg({ enabled: true });
    expect(ceilingFor(c, "inbox")).toBeNull();
    expect(ceilingFor(c, "playground")).toBeNull();
  });
});

describe("reading the ceiling out of the settings bag", () => {
  test("an absent block is the defaults, and switched off", () => {
    expect(readSpendCeilingConfig({})).toEqual(SPEND_CEILING_DEFAULTS);
    expect(readSpendCeilingConfig(null).enabled).toBe(false);
  });

  // Malformed input CLAMPS to the default rather than throwing, and never to "no ceiling": a bad
  // write reaching the webhook must not be able to switch the guard off.
  test.each([
    ["a negative ceiling", -5],
    ["a fractional ceiling", Number.NaN],
    ["a ceiling that is not a number", "1000"],
    ["a ceiling that is infinite", Number.POSITIVE_INFINITY],
  ])("%s falls back to the default", (_name, value) => {
    const cfgRead = readSpendCeilingConfig({
      spendCeiling: { enabled: true, monthlyInboxTokens: value },
    });
    expect(cfgRead.monthlyInboxTokens).toBe(
      SPEND_CEILING_DEFAULTS.monthlyInboxTokens,
    );
  });

  test("a fractional ceiling is floored, never rounded up", () => {
    expect(
      readSpendCeilingConfig({ spendCeiling: { monthlyInboxTokens: 10.9 } })
        .monthlyInboxTokens,
    ).toBe(10);
  });

  test("the warning fraction cannot exceed a whole ceiling", () => {
    expect(
      readSpendCeilingConfig({ spendCeiling: { warnAtPercent: 250 } })
        .warnAtPercent,
    ).toBe(100);
  });

  // An explicit null is the operator saying "say nothing", and an empty string is the same thing
  // typed into a text box. Neither may come back as the default sentence.
  test.each([
    ["an explicit null", null],
    ["an empty string", ""],
    ["a string of spaces", "   "],
  ])("%s means the customer is told nothing", (_name, value) => {
    expect(
      readSpendCeilingConfig({ spendCeiling: { overCeilingMessage: value } })
        .overCeilingMessage,
    ).toBeNull();
  });

  // WHAT THE READER OWES THE WRITER. `updateSpendCeiling` merges this output with the operator's
  // patch and validates the MERGE, so a value the schema refuses turns every save on the screen into
  // a 422 about a field the operator never touched. Asserted as one round trip rather than field by
  // field, so a field added to the block later is covered the day it is added.
  test("nothing the reader returns is anything the writer would refuse", () => {
    const absurd = {
      spendCeiling: {
        enabled: true,
        monthlyInboxTokens: SPEND_CEILING_TOKENS_MAX * 10,
        monthlyPlaygroundTokens: Number.MAX_SAFE_INTEGER,
        overCeilingMessage: "x".repeat(10_000),
        handoffEnabled: true,
        noticeCooldownSeconds: 86_400,
        warnAtPercent: 250,
      },
    };
    const read = readSpendCeilingConfig(absurd);
    expect(() => spendCeilingSettingsSchema.parse(read)).not.toThrow();
    // ...and each clamp lands on the safe side of its own field: a ceiling that is lower, a notice
    // that speaks more often.
    expect(read.monthlyInboxTokens).toBe(SPEND_CEILING_TOKENS_MAX);
    expect(read.monthlyPlaygroundTokens).toBe(SPEND_CEILING_TOKENS_MAX);
    expect(read.noticeCooldownSeconds).toBe(
      SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS,
    );
  });

  test("handoff stays on unless it is switched off explicitly", () => {
    expect(readSpendCeilingConfig({ spendCeiling: {} }).handoffEnabled).toBe(
      true,
    );
    expect(
      readSpendCeilingConfig({ spendCeiling: { handoffEnabled: false } })
        .handoffEnabled,
    ).toBe(false);
  });
});

describe("the window", () => {
  test("is the calendar month in UTC", () => {
    expect(monthStart(new Date("2026-08-26T22:41:00Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    // The last instant of the month still belongs to it, and the first of the next does not.
    expect(monthStart(new Date("2026-08-31T23:59:59Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(monthStart(new Date("2026-09-01T00:00:00Z")).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  // The upper end, which the query did not have until the verdict started carrying the instant it
  // was evaluated at. Exclusive, so `[monthStart, monthEnd)` partitions the ledger instead of
  // overlapping: whatever `monthEnd` returns for a month is what `monthStart` returns for the next.
  test("closes at the first instant of the next month, exclusive", () => {
    expect(monthEnd(new Date("2026-08-26T22:41:00Z")).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(monthEnd(new Date("2026-08-01T00:00:00Z")).toISOString()).toBe(
      monthStart(new Date("2026-09-01T00:00:00Z")).toISOString(),
    );
  });

  // December rolls the YEAR, which is the one case a month arithmetic gets wrong by hand. `Date.UTC`
  // normalises month 12 on its own, and this is what says so.
  test("December closes on January of the next year", () => {
    expect(monthEnd(new Date("2026-12-31T23:59:59.999Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

// HOW OFTEN THE WARNING IS SAID. `over` is a per-message fact and belongs on the Logs page once per
// refused customer; the warning describes the MONTH and stays true from the fraction to the
// ceiling, so emitting it per message would page the alert channels for the rest of the month about
// one unchanging thing. The alert bus does not bound that on its own: it coalesces a burst by
// bumping a PENDING delivery, and inserts a fresh one the moment the worker has sent the last.
describe("how often the ceiling announces itself", () => {
  beforeEach(() => clearContactAuthState());

  const over = { state: "over" as const, usedTokens: 200, ceilingTokens: 100 };
  const warn = {
    state: "warning" as const,
    usedTokens: 90,
    ceilingTokens: 100,
  };

  test("an allowed verdict writes nothing", () => {
    expect(
      spendCeilingAnnouncement(
        { state: "allowed", usedTokens: 5, ceilingTokens: 100 },
        "inbox",
        7n,
      ),
    ).toBeNull();
  });

  test("every refused message is written", () => {
    const said = [0, 1, 2, 3, 4].map(
      () => spendCeilingAnnouncement(over, "inbox", 7n)?.level ?? null,
    );
    expect(said).toEqual(["error", "error", "error", "error", "error"]);
  });

  test("the warning is said once per window, not once per message", () => {
    const said = [0, 1, 2, 3, 4].map(
      () => spendCeilingAnnouncement(warn, "inbox", 7n)?.level ?? null,
    );
    expect(said).toEqual(["warn", null, null, null, null]);
  });

  // THE WINDOW BELONGS TO THE MONTH IT IS ABOUT. Six hours is longer than the gap between the last
  // message of one month and the first of the next, so a window that carried only tenant and source
  // would suppress the first warning of a month whose ledger reads zero — on the strength of a
  // sentence about a month that has ended.
  // The instant comes off the VERDICT, not off the reader's own clock: it is the same timestamp the
  // ledger was summed against, so the window a warning claims always belongs to the month its
  // figures describe.
  test("a new month is not silenced by the previous month's warning", () => {
    const at = (iso: string) => ({ ...warn, evaluatedAt: new Date(iso) });
    expect(
      spendCeilingAnnouncement(at("2026-08-31T23:30:00.000Z"), "inbox", 7n)
        ?.level,
    ).toBe("warn");
    // Same month, inside the window: still silent, which is the rule this must not weaken.
    expect(
      spendCeilingAnnouncement(at("2026-08-31T23:59:00.000Z"), "inbox", 7n),
    ).toBeNull();
    expect(
      spendCeilingAnnouncement(at("2026-09-01T00:30:00.000Z"), "inbox", 7n)
        ?.level,
    ).toBe("warn");
  });

  // ONE LINE PER REFUSED OCCASION. Without a window the `over` line is written every time it is
  // asked, which is right for a customer message and wrong for a scheduled nudge: that one comes
  // back every fifteen minutes for two hours against a wall that does not move.
  test("a retried occasion is written once, and a fresh one is still written", () => {
    const occasion = { key: "nudge:77", windowMs: 7_200_000 };
    const said = [0, 1, 2, 3].map(
      () =>
        spendCeilingAnnouncement(over, "inbox", 7n, occasion)?.level ?? null,
    );
    expect(said).toEqual(["error", null, null, null]);
    // A different conversation is a different occasion, so it is not swallowed with it.
    expect(
      spendCeilingAnnouncement(over, "inbox", 7n, {
        key: "nudge:78",
        windowMs: 7_200_000,
      })?.level,
    ).toBe("error");
    // ...and a caller that does NOT retry keeps writing every refusal, which is the webhook.
    expect(
      [0, 1].map(
        () => spendCeilingAnnouncement(over, "inbox", 7n)?.level ?? null,
      ),
    ).toEqual(["error", "error"]);
  });

  // The two halves have separate ceilings, so they get separate windows: the playground warning
  // must not be swallowed by an inbox one said a minute earlier.
  test("each source keeps its own window", () => {
    expect(spendCeilingAnnouncement(warn, "inbox", 7n)).not.toBeNull();
    expect(spendCeilingAnnouncement(warn, "playground", 7n)).not.toBeNull();
  });

  // ...and so does each tenant, for the same reason one tenant's month says nothing about another's.
  test("each tenant keeps its own window", () => {
    expect(spendCeilingAnnouncement(warn, "inbox", 7n)).not.toBeNull();
    expect(spendCeilingAnnouncement(warn, "inbox", 8n)).not.toBeNull();
  });
});

// TWO DELIVERIES OF ONE MOMENT. Chatwoot dispatches an incoming message to the conversation's
// assigned agent bot AND to the inbox's, which is two deliveries with two ids; the debounce flush
// can also reach this branch alongside one of them. The per-notice claims make each write happen
// once and say nothing about ORDER, so the second caller used to find the copy's window held, skip
// to the handoff, and open the conversation while the first was still awaiting its send.
describe("two over-ceiling sequences on one conversation", () => {
  beforeEach(() => {
    clearContactAuthState();
    clearSpendCeilingFlights();
  });

  const ceilingCfg = {
    ...SPEND_CEILING_DEFAULTS,
    enabled: true,
    monthlyInboxTokens: 100,
    overCeilingMessage: "Orçamento do mês esgotado.",
  };

  test("a second delivery of one message inherits the first's answer", async () => {
    const order: string[] = [];
    const copyStarted = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    const run = (label: string, slowCopy: boolean) =>
      announceSpendCeilingOnConversation({
        tenantId: 7n,
        conversationRowId: 99n,
        // ONE message, two deliveries: that is what Chatwoot's fan-out is.
        occasion: "message:500",
        cfg: ceilingCfg,
        verdict: { usedTokens: 200, ceilingTokens: 100 },
        postPublicMessage: async () => {
          order.push(`copy:${label}`);
          if (slowCopy) {
            copyStarted.resolve();
            await held.promise;
          }
          order.push(`copy-done:${label}`);
          return true;
        },
        postPrivateNote: async () => {
          order.push(`note:${label}`);
          return true;
        },
        handoff: async () => {
          order.push(`handoff:${label}`);
          return true;
        },
      });

    const first = run("A", true);
    // Started, and parked inside the send: this is the exact window the race lived in.
    await copyStarted.promise;
    const second = run("B", false);
    held.resolve();
    const [a, b] = await Promise.all([first, second]);

    // B never ran a sequence of its own; it inherited A's answer, because it is the same refusal.
    expect(order).toEqual(["copy:A", "copy-done:A", "handoff:A", "note:A"]);
    expect(a).toEqual({ handedOff: true });
    expect(b).toEqual(a);
  });

  // ...and the flight is per CONVERSATION. A key that dropped it would pass the test above while
  // making every other conversation on the tenant inherit one performance of the sequence, which is
  // the same class of bug as a notice window that forgets its subject.
  test("two conversations do not share a flight", async () => {
    const ran: string[] = [];
    const parked = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const run = (conversationRowId: bigint, park: boolean) =>
      announceSpendCeilingOnConversation({
        tenantId: 7n,
        conversationRowId,
        occasion: "message:600",
        cfg: ceilingCfg,
        verdict: { usedTokens: 200, ceilingTokens: 100 },
        postPublicMessage: async () => {
          ran.push(`copy:${conversationRowId}`);
          if (park) {
            started.resolve();
            await parked.promise;
          }
          return true;
        },
        postPrivateNote: async () => true,
        handoff: async () => true,
      });

    const first = run(101n, true);
    await started.promise;
    // Different conversation, while the first is parked mid-send: it must run, not wait.
    await run(102n, false);
    expect(ran).toEqual(["copy:101", "copy:102"]);
    parked.resolve();
    await first;
  });

  // TWO MESSAGES ARE TWO REFUSALS, and the ordering is what the conversation buys, not silence. With
  // the cooldown at 0 the operator is saying every refusal is to be voiced, so a second message
  // arriving while the first is mid-send must get its own sequence — and it must not interleave with
  // it, which is why the two run one after the other rather than at the same time.
  test("a second message runs its own sequence, after the first", async () => {
    const order: string[] = [];
    const parked = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const noCooldown = { ...ceilingCfg, noticeCooldownSeconds: 0 };
    const run = (occasion: string, park: boolean) =>
      announceSpendCeilingOnConversation({
        tenantId: 7n,
        conversationRowId: 97n,
        occasion,
        cfg: noCooldown,
        verdict: { usedTokens: 200, ceilingTokens: 100 },
        postPublicMessage: async () => {
          order.push(`copy:${occasion}`);
          if (park) {
            started.resolve();
            await parked.promise;
          }
          return true;
        },
        postPrivateNote: async () => {
          order.push(`note:${occasion}`);
          return true;
        },
        handoff: async () => {
          order.push(`handoff:${occasion}`);
          return true;
        },
      });

    const first = run("message:1", true);
    await started.promise;
    const second = run("message:2", false);
    parked.resolve();
    await Promise.all([first, second]);
    // Both spoke, and the second did not overtake the first: no act of message 2 lands between the
    // acts of message 1.
    expect(order).toEqual([
      "copy:message:1",
      "handoff:message:1",
      "note:message:1",
      "copy:message:2",
      "handoff:message:2",
      "note:message:2",
    ]);
  });

  // ...and the flight is released when it settles, so the NEXT refusal is not swallowed by a
  // sequence that already finished. The claims are what make it quiet, not the flight.
  test("a later sequence runs on its own, and the claims are what silence it", async () => {
    const order: string[] = [];
    const run = () =>
      announceSpendCeilingOnConversation({
        tenantId: 7n,
        conversationRowId: 98n,
        occasion: "message:700",
        cfg: ceilingCfg,
        verdict: { usedTokens: 200, ceilingTokens: 100 },
        postPublicMessage: async () => {
          order.push("copy");
          return true;
        },
        postPrivateNote: async () => {
          order.push("note");
          return true;
        },
        handoff: async () => {
          order.push("handoff");
          return true;
        },
      });
    await run();
    await run();
    // The handoff runs both times (it is outside the cooldown on purpose, so a failed open retries);
    // the copy and the note are said once per window.
    expect(order).toEqual(["copy", "handoff", "note", "handoff"]);
  });
});
