import { describe, expect, test } from "bun:test";
import {
  COST_DIVERGENCE_FLOOR_USD,
  COST_DIVERGENCE_RELATIVE,
  compareModelCosts,
  judgeCosts,
  matchLedgerModel,
  snapshotBase,
} from "@/modules/analytics/cost-divergence";

// Issue #868: the local price table's cost per model checked against Langfuse's. A model is flagged
// only when the two part by more than a fifth of the larger AND by at least a dollar; a model with a
// call the local table could not price is neither flagged nor passed; and a name only one side has is
// reported as such, never as a divergence.

describe("the thresholds", () => {
  test("are a fifth and a dollar", () => {
    expect(COST_DIVERGENCE_RELATIVE).toBe(0.2);
    expect(COST_DIVERGENCE_FLOOR_USD).toBe(1);
  });

  test("a relative gap under the dollar floor is not a divergence", () => {
    // 90% apart, and ninety cents.
    expect(judgeCosts(0.1, 1.0, 3, 3)).toBe("match");
    expect(judgeCosts(1.0, 0.1, 3, 3)).toBe("match");
  });

  test("a dollar gap under the relative threshold is not a divergence", () => {
    // $10 apart on $100: a tenth.
    expect(judgeCosts(100, 90, 5, 5)).toBe("match");
    // Exactly a fifth is not MORE than a fifth.
    expect(judgeCosts(10, 8, 5, 5)).toBe("match");
  });

  test("both past their threshold is a divergence, whichever side is larger", () => {
    expect(judgeCosts(10, 7.9, 5, 5)).toBe("diverges");
    expect(judgeCosts(7.9, 10, 5, 5)).toBe("diverges");
  });

  test("the dollar floor is met at exactly a dollar, counted in cents", () => {
    // `1.1 - 0.1` is 1.0000000000000002 to a double and `2.3 - 1.3` is 0.9999999999999998: both
    // are a dollar.
    expect(judgeCosts(1.1, 0.1, 1, 1)).toBe("diverges");
    expect(judgeCosts(2.3, 1.3, 1, 1)).toBe("diverges");
    expect(judgeCosts(1.09, 0.1, 1, 1)).toBe("match");
  });

  test("a model priced by the tenant's own price is not judged against Langfuse's table", () => {
    // What the card tells the operator to do when the account pays a price neither table knows:
    // after it, the local figure is that price, and flagging it would never clear.
    expect(judgeCosts(10, 2, 5, 5, 1)).toBe("own");
    expect(judgeCosts(10, 2, 5, 5, 0)).toBe("diverges");
    // An unpriced call still makes it incomplete first.
    expect(judgeCosts(10, 2, 5, 4, 1)).toBe("incomplete");
  });

  test("one unpriced local call makes the model incomplete, never a verdict", () => {
    expect(judgeCosts(1, 50, 4, 3)).toBe("incomplete");
    expect(judgeCosts(50, 50, 4, 3)).toBe("incomplete");
    expect(judgeCosts(0, 0, 4, 0)).toBe("incomplete");
  });

  test("two zero figures agree", () => {
    expect(judgeCosts(0, 0, 2, 2)).toBe("match");
  });
});

describe("matching the names", () => {
  const ledger = new Set(["gpt-4o", "claude-sonnet-4", "claude-3-5-sonnet-v2"]);

  test("exact first", () => {
    expect(matchLedgerModel("gpt-4o", ledger)).toBe("gpt-4o");
  });

  test("a dated snapshot matches the model it is a snapshot of", () => {
    expect(matchLedgerModel("gpt-4o-2024-08-06", ledger)).toBe("gpt-4o");
    expect(matchLedgerModel("claude-sonnet-4-20250514", ledger)).toBe(
      "claude-sonnet-4",
    );
    expect(matchLedgerModel("claude-3-5-sonnet-v2@20241022", ledger)).toBe(
      "claude-3-5-sonnet-v2",
    );
  });

  test("an exact ledger name that looks dated is not stripped", () => {
    const dated = new Set(["gpt-4o", "gpt-4o-2024-08-06"]);
    expect(matchLedgerModel("gpt-4o-2024-08-06", dated)).toBe(
      "gpt-4o-2024-08-06",
    );
  });

  test("anything else is no match", () => {
    expect(matchLedgerModel("gpt-4o-mini", ledger)).toBeNull();
    expect(matchLedgerModel("gpt-4o-preview", ledger)).toBeNull();
    // Seven digits is not a date.
    expect(matchLedgerModel("gpt-4o-2024080", ledger)).toBeNull();
    expect(matchLedgerModel("unknown", ledger)).toBeNull();
  });

  test("the suffix is only ever at the end", () => {
    expect(snapshotBase("gpt-4o-2024-08-06-extra")).toBeNull();
    expect(snapshotBase("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(snapshotBase("gpt-4o-20240806")).toBe("gpt-4o");
    expect(snapshotBase("@20241022")).toBeNull();
  });
});

describe("compareModelCosts", () => {
  test("sums every Langfuse name of one ledger model, and reports the one-sided names", () => {
    const check = compareModelCosts(
      [
        { model: "gpt-4o", calls: 10, pricedCalls: 10, costUsd: 3 },
        { model: "claude-sonnet-4", calls: 4, pricedCalls: 3, costUsd: 2 },
        { model: "only-local-b", calls: 1, pricedCalls: 1, costUsd: 0.5 },
        { model: "only-local-a", calls: 1, pricedCalls: 1, costUsd: 0.5 },
      ],
      [
        { model: "gpt-4o-2024-08-06", costUsd: 4 },
        { model: "gpt-4o", costUsd: 3 },
        { model: "claude-sonnet-4-20250514", costUsd: 9 },
        { model: "unknown", costUsd: 0 },
        { model: "only-langfuse", costUsd: 20 },
      ],
    );
    expect(check.models).toEqual([
      {
        model: "claude-sonnet-4",
        ledgerModels: ["claude-sonnet-4"],
        langfuseModels: ["claude-sonnet-4-20250514"],
        localUsd: 2,
        langfuseUsd: 9,
        calls: 4,
        localUnpricedCalls: 1,
        status: "incomplete",
      },
      {
        model: "gpt-4o",
        ledgerModels: ["gpt-4o"],
        langfuseModels: ["gpt-4o-2024-08-06", "gpt-4o"],
        localUsd: 3,
        langfuseUsd: 7,
        calls: 10,
        localUnpricedCalls: 0,
        status: "diverges",
      },
    ]);
    expect(check.onlyInLangfuse).toEqual(["unknown", "only-langfuse"]);
    expect(check.onlyLocal).toEqual(["only-local-a", "only-local-b"]);
  });

  test("a large one-sided model is never a divergence", () => {
    const check = compareModelCosts(
      [{ model: "a", calls: 100, pricedCalls: 100, costUsd: 500 }],
      [{ model: "b", costUsd: 900 }],
    );
    expect(check.models).toEqual([]);
    expect(check.onlyLocal).toEqual(["a"]);
    expect(check.onlyInLangfuse).toEqual(["b"]);
  });

  test("a model whose figures agree is a match", () => {
    const check = compareModelCosts(
      [{ model: "a", calls: 3, pricedCalls: 3, costUsd: 10 }],
      [{ model: "a", costUsd: 10.5 }],
    );
    expect(check.models[0]?.status).toBe("match");
  });

  // Review of #868: calls configured with both an alias and its dated snapshot can all reach
  // Langfuse under the snapshot's name, so that name's figure cannot be handed to either ledger
  // model alone.
  test("an alias and its dated snapshot both in the ledger are compared as one group", () => {
    const check = compareModelCosts(
      [
        { model: "gpt-4o", calls: 5, pricedCalls: 5, costUsd: 10 },
        { model: "gpt-4o-2024-08-06", calls: 5, pricedCalls: 5, costUsd: 10 },
      ],
      [{ model: "gpt-4o-2024-08-06", costUsd: 20 }],
    );
    expect(check.models).toEqual([
      {
        model: "gpt-4o",
        ledgerModels: ["gpt-4o", "gpt-4o-2024-08-06"],
        langfuseModels: ["gpt-4o-2024-08-06"],
        localUsd: 20,
        langfuseUsd: 20,
        calls: 10,
        localUnpricedCalls: 0,
        status: "match",
      },
    ]);
    expect(check.onlyLocal).toEqual([]);
    expect(check.onlyInLangfuse).toEqual([]);
  });

  test("the group takes every Langfuse name of its members, and still flags a real gap", () => {
    const check = compareModelCosts(
      [
        { model: "gpt-4o", calls: 5, pricedCalls: 5, costUsd: 10 },
        { model: "gpt-4o-2024-08-06", calls: 5, pricedCalls: 4, costUsd: 10 },
        { model: "claude-x", calls: 1, pricedCalls: 1, costUsd: 3 },
      ],
      [
        { model: "gpt-4o-2024-08-06", costUsd: 15 },
        { model: "gpt-4o", costUsd: 2 },
        { model: "claude-x", costUsd: 3 },
      ],
    );
    const group = check.models.find((c) => c.ledgerModels.length > 1);
    expect(group).toEqual({
      model: "gpt-4o",
      ledgerModels: ["gpt-4o", "gpt-4o-2024-08-06"],
      langfuseModels: ["gpt-4o-2024-08-06", "gpt-4o"],
      localUsd: 20,
      langfuseUsd: 17,
      calls: 10,
      localUnpricedCalls: 1,
      status: "incomplete",
    });
    // A model no ambiguous name touches is still compared on its own.
    expect(
      check.models.find((c) => c.model === "claude-x")?.ledgerModels,
    ).toEqual(["claude-x"]);
    expect(check.models).toHaveLength(2);
  });

  test("a dated ledger name with no alias in the ledger is not grouped", () => {
    const check = compareModelCosts(
      [{ model: "gpt-4o-2024-08-06", calls: 1, pricedCalls: 1, costUsd: 10 }],
      [{ model: "gpt-4o-2024-08-06", costUsd: 30 }],
    );
    expect(check.models[0]?.ledgerModels).toEqual(["gpt-4o-2024-08-06"]);
    expect(check.models[0]?.status).toBe("diverges");
  });
});
