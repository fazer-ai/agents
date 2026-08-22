import { describe, expect, test } from "bun:test";
import {
  INGEST_ID_WINDOW,
  type IngestVerdict,
  ingestVerdict,
  rememberIngested,
} from "@/graph/ingest-dedup";

// Issue #194. The table is the point: this decides whether a customer's words enter the memory the
// agent reads for the next twenty attendances, and the wrong cell is not recoverable — nothing
// re-delivers a message ingestion refused.

const full = (from: number) =>
  Array.from({ length: INGEST_ID_WINDOW }, (_, i) => from + i);

describe("ingestVerdict", () => {
  const cases: [string, number[], number, IngestVerdict][] = [
    ["nothing remembered yet", [], 100, "new"],
    ["a genuine re-delivery", [100, 101], 100, "duplicate"],
    ["a higher id, in order", [100, 101], 102, "new"],
    // THE #194 CASE. Under the high-water mark this read as handled and the message was lost.
    ["a lower id that was never folded in", [200], 100, "new"],
    ["a lower id, window not saturated", [150, 200, 300], 120, "new"],
    // Saturation is what makes a low id ambiguous, and only then is it refused.
    [
      "below the oldest id a SATURATED window holds",
      full(1000),
      999,
      "ancient",
    ],
    ["the oldest id a saturated window holds", full(1000), 1000, "duplicate"],
    ["above a saturated window", full(1000), 5000, "new"],
    // Above the oldest id it holds but never folded in: a gap inside the span is still `new`, which
    // is what keeps a reorder ingestable right up to the edge of what the window remembers.
    [
      "unseen, above the oldest id a saturated window holds",
      [...full(1000).slice(0, INGEST_ID_WINDOW - 1), 9000],
      1063,
      "new",
    ],
  ];
  for (const [name, recent, id, want] of cases) {
    test(`${name} -> ${want}`, () => {
      expect(ingestVerdict(recent, id)).toBe(want);
    });
  }

  // Asserted apart from the table because it is the property the window REPLACED and still owes:
  // whatever else changes, an id we remember folding in never gets folded in twice.
  test("membership decides a re-delivery at any position", () => {
    const recent = [500, 200, 501, 199];
    for (const id of recent)
      expect(ingestVerdict(recent, id)).toBe("duplicate");
  });
});

describe("rememberIngested", () => {
  test("keeps arrival order, most recent last", () => {
    expect(rememberIngested([200], 100)).toEqual([200, 100]);
  });

  test("caps by dropping the oldest ARRIVAL, not the lowest id", () => {
    const recent = rememberIngested(full(1000), 42);
    expect(recent.length).toBe(INGEST_ID_WINDOW);
    // 1000 arrived first, so it is what leaves; 42 is lowest and stays, because the cap protects
    // the memory of recent WORK and 42 is the most recent work there is.
    expect(recent).not.toContain(1000);
    expect(recent.at(-1)).toBe(42);
  });

  // The pair has to compose: an id just remembered must read as a duplicate on the next delivery,
  // and one just evicted must not read as `new` and get appended a second time.
  test("what it evicts becomes ancient, not new", () => {
    const recent = rememberIngested(full(1000), 5000);
    expect(ingestVerdict(recent, 5000)).toBe("duplicate");
    expect(ingestVerdict(recent, 1000)).toBe("ancient");
  });
});
