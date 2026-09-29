import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// Who may bring a `scheduler_jobs` row into existence, enforced per call site. A row's failure
// budget survives the unit of work that spent it, so whoever arms the row says what the re-arm
// MEANS (new work, or the same work pushed again); `enqueueJob` makes that a required field. The
// compiler cannot see a writer that never calls `enqueueJob`: a hand-copied upsert on DEBOUNCE (a
// dedupeKey that is the THREAD, reused by every burst) would keep a dead-lettered flush's spent
// attempts forever. So the fence is on the WRITE: one module creates the row, and a second writer
// fails here instead of inheriting a default nobody chose.

const OWNER = "src/modules/scheduler/service.ts";

// The spellings that CREATE a row, as text. Prisma's `upsert` counts because its `create` branch
// does; `update`/`updateMany`/`delete` do not, and neither does a plain read.
const CREATES_A_ROW = [
  /\bschedulerJob\s*\.\s*upsert\s*\(/,
  /\bschedulerJob\s*\.\s*create\s*\(/,
  /\bschedulerJob\s*\.\s*createMany\s*\(/,
  /\bINSERT\s+INTO\s+scheduler_jobs\b/i,
];

export function createsASchedulerRow(source: string): boolean {
  return CREATES_A_ROW.some((re) => re.test(source));
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFilesUnder(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("who may create a scheduler job row", () => {
  // A fence with no offender left passes over an empty set just as happily as over a correct one,
  // so the predicate is proved on fixtures BEFORE it is trusted on the tree — both directions, and
  // with the second spelling of the same thing written by hand (a formatter breaking the call across
  // lines is what a `\s*`-less pattern misses).
  test("the predicate catches every spelling of creating a row", () => {
    for (const offender of [
      `await db.schedulerJob.upsert({ where: {}, create: {}, update: {} });`,
      `await db.schedulerJob\n  .create({ data: {} });`,
      `await db.schedulerJob.createMany({ data: [] });`,
      "await db.$executeRaw`INSERT INTO scheduler_jobs (tenant_id) VALUES (1)`",
    ]) {
      expect(createsASchedulerRow(offender)).toBe(true);
    }
  });

  test("the predicate ignores reading or updating one", () => {
    for (const innocent of [
      `await db.schedulerJob.updateMany({ where: {}, data: {} });`,
      `await db.schedulerJob.findFirst({ where: {} });`,
      `await db.schedulerJob.deleteMany({ where: {} });`,
      "await db.$executeRaw`UPDATE scheduler_jobs SET status = 'DONE'`",
    ]) {
      expect(createsASchedulerRow(innocent)).toBe(false);
    }
  });

  test("exactly one module creates a scheduler job row", async () => {
    const root = join(import.meta.dir, "..", "..");
    const files = await tsFilesUnder(join(root, "src"));
    // Positive control on the SWEEP as well as on the predicate: a sweep that walked the wrong
    // directory would report an empty offender set and pass.
    expect(files.length).toBeGreaterThan(200);
    const writers: string[] = [];
    for (const file of files) {
      if (createsASchedulerRow(await Bun.file(file).text())) {
        writers.push(relative(root, file));
      }
    }
    expect(writers.sort()).toEqual([OWNER]);
  });
});
