import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type ClaimedJob,
  claimDueDebounceJobs,
  claimDueJobs,
  enqueueJob,
  retireJobsByDedupeKey,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import {
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  runClaimed,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";

// A DISCARDED OUTCOME LEAVES A LINE WHERE ALERTS LOOK (issue #896).
//
// Two roads discard what a scheduler handler returned: the run passed its deadline, or its claim was
// superseded. Both used to write to stdout only, so an alert channel never saw a follow-up whose next
// step was dropped. The deadline road now always writes a `dead_letter` warn; the supersede road does
// for FOLLOWUP, and stays quiet for DEBOUNCE, where a supersede is every burst that grows mid-run.
const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const past = () => new Date(Date.now() - 60_000);

async function claim(kind: SchedulerJobKind, id: bigint): Promise<ClaimedJob> {
  const jobs =
    kind === "DEBOUNCE"
      ? await claimDueDebounceJobs(10, appDb, new Date(), tenantId)
      : await claimDueJobs(10, appDb, new Date(), tenantId);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`row ${id} was not claimed`);
  return job;
}

async function arm(
  kind: SchedulerJobKind,
  key: string,
  payload: Record<string, unknown> = {},
): Promise<bigint> {
  return enqueueJob({
    rearm: "same-work",
    tenantId,
    kind,
    dedupeKey: key,
    runAt: past(),
    payload,
    base: appDb,
  });
}

const installed: Array<{ kind: string; previous: JobHandler | undefined }> = [];
function install(kind: string, handler: JobHandler) {
  installed.push({ kind, previous: getJobHandler(kind) });
  registerJobHandler(kind, handler);
}

async function discardLines() {
  return flowLogRows(suDb, {
    // flowlog-scope: tenant-wide — o tenant é deste arquivo e cada caso o esvazia antes; o sujeito é
    // QUANTAS linhas um descarte escreveu.
    where: { tenantId, stage: "dead_letter" },
    orderBy: { id: "asc" },
  });
}

// A claim whose row was re-armed and claimed again underneath it: its own outcome can no longer land.
async function superseded(
  kind: SchedulerJobKind,
  key: string,
  payload: Record<string, unknown> = {},
): Promise<{ first: ClaimedJob; id: bigint }> {
  const id = await arm(kind, key, payload);
  const first = await claim(kind, id);
  await arm(kind, key, payload);
  await claim(kind, id);
  return { first, id };
}

describe.skipIf(!dbUp)("a discarded scheduler outcome (issue #896)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DISCARD", slug: `discard-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterEach(async () => {
    for (const { kind, previous } of installed.splice(0).reverse()) {
      if (previous) registerJobHandler(kind, previous);
      else unregisterJobHandler(kind);
    }
    await clearFlowLog(suDb, { tenantId });
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    await clearFlowLog(suDb, { tenantId });
    await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("an outcome returned after the deadline writes one warn naming the job", async () => {
    await clearFlowLog(suDb, { tenantId });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    install("HEARTBEAT", async () => {
      await gate;
      return { outcome: "done" };
    });
    const id = await arm("HEARTBEAT", "discard-late");
    const job = await claim("HEARTBEAT", id);
    await runClaimed(job, appDb, { deadlineMs: 100 });
    release();
    await sleep(300);
    const lines = await discardLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.detail).toMatchObject({
      unit: "job",
      kind: "HEARTBEAT",
      jobId: String(id),
      discarded: "deadline",
    });
  });

  test("a superseded FOLLOWUP writes one warn naming the job and its conversation", async () => {
    await clearFlowLog(suDb, { tenantId });
    const threadId = `${tenantId}:1:4242`;
    install("FOLLOWUP", async () => ({ outcome: "done" }));
    const { first, id } = await superseded("FOLLOWUP", `followup:${threadId}`, {
      threadId,
    });
    await runClaimed(first, appDb);
    const lines = await discardLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.threadId).toBe(threadId);
    expect(lines[0]?.detail).toMatchObject({
      kind: "FOLLOWUP",
      jobId: String(id),
      discarded: "superseded",
      outcome: "done",
    });
    // The later claim still owns the row: the discarded outcome did not land.
    const row = await suDb.schedulerJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("CLAIMED");
  });

  // Review round 1: a command like /reset retires the claimed row on purpose (DONE, `cancelledAt`,
  // claim_seq bumped). The run's outcome is then fenced by design, and a warn would page an alert
  // channel for a retirement an operator asked for.
  test("a FOLLOWUP retired on purpose while it ran stays off the flow log", async () => {
    await clearFlowLog(suDb, { tenantId });
    const threadId = `${tenantId}:1:4343`;
    const key = `followup:${threadId}`;
    install("FOLLOWUP", async () => ({ outcome: "done" }));
    const id = await arm("FOLLOWUP", key, { threadId });
    const job = await claim("FOLLOWUP", id);
    expect(await retireJobsByDedupeKey(tenantId, "FOLLOWUP", key, appDb)).toBe(
      1,
    );
    await runClaimed(job, appDb);
    expect(await discardLines()).toHaveLength(0);
    const row = await suDb.schedulerJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("DONE");
  });

  test("a superseded DEBOUNCE flush stays off the flow log", async () => {
    await clearFlowLog(suDb, { tenantId });
    install("DEBOUNCE", async () => ({ outcome: "done" }));
    const { first } = await superseded("DEBOUNCE", "debounce:discard");
    await runClaimed(first, appDb);
    expect(await discardLines()).toHaveLength(0);
  });
});
