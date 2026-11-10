import { expect, test } from "bun:test";
import {
  DRIFT_LEFT_OUT_TOP,
  type DriftCandidate,
  pickDrift,
} from "@/modules/instance-health/database/drift";

// Which statement is the drift signal's value, and which are listed as left out for too few calls,
// as a table: the floor is passed in, so each row reads the rule and not the default.

const c = (
  queryid: string,
  calls: number,
  pct: number,
  userid = "10",
): DriftCandidate => ({
  userid,
  queryid,
  query: `SELECT ${queryid}`,
  calls,
  meanMs: pct * 50,
  budgetMs: 5_000,
  pct,
});

const cases: {
  name: string;
  floor: number;
  input: DriftCandidate[];
  best: string | null;
  leftOut: string[];
}[] = [
  {
    name: "one slow call alone is no value, and is left out",
    floor: 3,
    input: [c("a", 1, 58)],
    best: null,
    leftOut: ["a"],
  },
  {
    name: "at the floor the same share is the value",
    floor: 3,
    input: [c("a", 3, 58)],
    best: "a",
    leftOut: [],
  },
  {
    name: "one below the floor is left out",
    floor: 3,
    input: [c("a", 2, 58)],
    best: null,
    leftOut: ["a"],
  },
  {
    name: "a smaller share past the floor is the value, the larger one below it is left out",
    floor: 3,
    input: [c("a", 1, 58), c("c", 40, 20)],
    best: "c",
    leftOut: ["a"],
  },
  {
    name: "a statement below the floor and below the value is not listed",
    floor: 3,
    input: [c("a", 1, 5), c("c", 40, 20)],
    best: "c",
    leftOut: [],
  },
  {
    name: "a floor of 1 takes every statement, as before",
    floor: 1,
    input: [c("a", 1, 58), c("c", 40, 20)],
    best: "a",
    leftOut: [],
  },
  {
    name: "left out are ordered by share, ties by queryid",
    floor: 3,
    input: [c("b", 1, 40), c("a", 2, 40), c("d", 1, 90)],
    best: null,
    leftOut: ["d", "a", "b"],
  },
];

for (const k of cases) {
  test(k.name, () => {
    const got = pickDrift(k.input, k.floor);
    expect(got.best?.queryid ?? null).toBe(k.best);
    expect(got.leftOut.map((x) => x.queryid)).toEqual(k.leftOut);
    expect(got.leftOutCount).toBe(k.leftOut.length);
  });
}

test("the same text run by two roles is two statements, each listed", () => {
  const got = pickDrift([c("a", 1, 70, "11"), c("a", 1, 70, "10")], 3);
  expect(got.leftOut.map((x) => `${x.userid}:${x.queryid}`)).toEqual([
    "10:a",
    "11:a",
  ]);
});

test("the list stops at its cap and the count does not", () => {
  const many = Array.from({ length: DRIFT_LEFT_OUT_TOP + 5 }, (_, i) =>
    c(String(i).padStart(3, "0"), 1, 60 + i),
  );
  const got = pickDrift(many, 3);
  expect(got.leftOut).toHaveLength(DRIFT_LEFT_OUT_TOP);
  expect(got.leftOutCount).toBe(DRIFT_LEFT_OUT_TOP + 5);
  expect(got.leftOut[0]?.pct).toBe(60 + DRIFT_LEFT_OUT_TOP + 4);
});
