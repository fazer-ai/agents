import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { FLEET_ROLE_EXPR } from "@/lib/tenancy/fleet-role";
import { CONNECT_ATTEMPT_MS, DB_GATE_OPT_OUT, retryConnect } from "./db-gate";
import { isWorkerCloneOf, testDbNameFor, withDbName } from "./db-name";
import {
  acquireRoleCatalogLock,
  ROLE_CATALOG_LOCK,
} from "./utils/role-catalog-lock";

// ONE DATABASE PER WORKER UNDER `bun test --parallel`: files running at once on one database
// collide, so each worker runs on a `CREATE DATABASE … TEMPLATE` copy of the checkout's test database
// (serial runs and CI keep the checkout's). `--parallel` isolates each file, globals and `process.env`
// included, so the copy itself is the worker's only memory: each file asks Postgres whether it is
// there and whose it is. No `exit` handler runs in a worker, so ownership is recorded on the copy
// (the `bun test` pid and start time) and a copy whose owner is gone is dropped by the next worker
// that takes the lock, or by the reaper below. Copies are made one at a time under an advisory lock in
// `postgres`, because Postgres refuses to copy a database that has connections.

export const CLONE_MARKER_ENV = "TEST_DB_WORKER_CLONE";
export const CLONE_APP = "fazerai-test-clone";

const OWNER_MARK = "fazerai-test-clone";

export type CloneOwner = {
  template: string;
  pid: number;
  start: string;
  workerPid: number;
  ready: boolean;
};

export function ownerComment(o: CloneOwner): string {
  return JSON.stringify({ [OWNER_MARK]: 1, ...o });
}

export function parseOwner(comment: string | null): CloneOwner | null {
  if (!comment) return null;
  try {
    const o = JSON.parse(comment) as Partial<CloneOwner> & {
      [OWNER_MARK]?: unknown;
    };
    if (
      o[OWNER_MARK] !== 1 ||
      typeof o.template !== "string" ||
      typeof o.pid !== "number" ||
      typeof o.start !== "string" ||
      typeof o.workerPid !== "number" ||
      typeof o.ready !== "boolean"
    ) {
      return null;
    }
    return {
      template: o.template,
      pid: o.pid,
      start: o.start,
      workerPid: o.workerPid,
      ready: o.ready,
    };
  } catch {
    return null;
  }
}

// The copy this process should run on, or null to stay on `checkoutDb`. Only a worker clones
// (BUN_TEST_WORKER_ID is unset in a serial run). A run nested inside a worker inherits the worker's
// variables: with the marker it keeps whatever database its caller handed it, which may be a scratch
// database a test built on purpose, and without it the derivation lands on the worker's copy anyway.
export function workerCloneTarget(
  env: { [k: string]: string | undefined },
  checkoutDb: string,
  root: string,
): string | null {
  const worker = env.BUN_TEST_WORKER_ID;
  if (!worker || env[DB_GATE_OPT_OUT] === "1" || env[CLONE_MARKER_ENV]) {
    return null;
  }
  const clone = testDbNameFor(checkoutDb, root, worker);
  return clone === checkoutDb ? null : clone;
}

// `startOf(pid)` is the process's start time, or null when there is none: the pid alone is not the
// run, because the kernel hands a dead run's pid to the next process.
function ownerAlive(
  o: CloneOwner,
  startOf: (pid: number) => string | null,
): boolean {
  return startOf(o.pid) === o.start;
}

// Which of this checkout's copies are left over. Only names of THIS checkout's shape are candidates,
// so another checkout's copies are never touched; among them, one made from another template is that
// template's run's business. Called under the clone lock, so a copy with no record is one whose
// worker died between CREATE and COMMENT, not one being created.
export function clonesToDrop(
  rows: { name: string; comment: string | null }[],
  scope: { root: string; template: string },
  startOf: (pid: number) => string | null,
): string[] {
  return rows
    .filter((r) => isWorkerCloneOf(r.name, scope.root))
    .filter((r) => {
      const o = parseOwner(r.comment);
      if (o === null) return true;
      if (o.template !== scope.template) return false;
      return !ownerAlive(o, startOf);
    })
    .map((r) => r.name);
}

export type CloneVerdict = "use" | "create" | "recreate" | "refuse";

// What a worker does with its copy once it holds the lock and the leftovers are gone. `existing` is
// undefined when there is no such database and null when it carries no record. The owner is the
// `bun test` that started this worker, or one further up when this run is nested inside a worker.
export function cloneVerdict(
  existing: CloneOwner | null | undefined,
  me: { pid: number; ancestors: number[] },
  startOf: (pid: number) => string | null,
): CloneVerdict {
  if (existing === undefined) return "create";
  if (existing === null || !existing.ready) return "recreate";
  if (!ownerAlive(existing, startOf)) return "recreate";
  return me.ancestors.includes(existing.pid) ? "use" : "refuse";
}

// What a worker decides from one query, before the lock: its own ready copy is used (even if the
// template went away mid-run, the copy is still whole); with no template to copy, the file stops here
// with the command that provisions it; anything else takes the slow path. "Its own" is the pids AND
// the owner's start time, since a copy left by a run whose pids came back after a reboot matches on
// pids alone.
export function fastPath(
  state: { template: boolean; clone: CloneOwner | null | undefined },
  me: { pid: number; ppid: number },
  startOf: (pid: number) => string | null,
): "use" | "no-template" | "slow" {
  const c = state.clone;
  if (
    c?.ready &&
    c.workerPid === me.pid &&
    (c.pid === me.ppid || c.pid === me.pid) &&
    ownerAlive(c, startOf)
  ) {
    return "use";
  }
  return state.template ? "slow" : "no-template";
}

function noTemplate(template: string): Error {
  return new Error(
    `the test database "${template}" does not exist, so there is nothing to copy for this worker. Run: bun run db:test:setup`,
  );
}

// `ps` runs through an awaited `Bun.spawn`: a `spawnSync` inside a `bun test --parallel` worker can
// stop returning and spin at full CPU, which leaves the run waiting on that worker forever. The locale
// and the zone are fixed because `lstart` is the ownership token: two runs, or a run and its detached
// reaper, with different `TZ` would read the same start as two different processes.
async function ps(args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["ps", ...args], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return code === 0 ? out : null;
}

export async function processStart(pid: number): Promise<string | null> {
  const out = (await ps(["-o", "lstart=", "-p", String(pid)]))?.trim() ?? "";
  return out.length > 0 ? out : null;
}

// Start times of every pid named, gathered up front so the decisions above can stay synchronous.
async function startsOf(
  pids: number[],
): Promise<(pid: number) => string | null> {
  const starts = new Map<number, string | null>();
  for (const pid of new Set(pids)) starts.set(pid, await processStart(pid));
  return (pid) => starts.get(pid) ?? null;
}

async function ancestorsOf(
  pid: number,
): Promise<{ pids: number[]; parentCmd: string }> {
  const out = (await ps(["-A", "-o", "pid=,ppid=,comm="])) ?? "";
  const parent = new Map<number, { ppid: number; comm: string }>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) parent.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] ?? "" });
  }
  const pids: number[] = [];
  let cur = parent.get(pid)?.ppid;
  while (cur !== undefined && cur > 1 && pids.length < 16) {
    pids.push(cur);
    cur = parent.get(cur)?.ppid;
  }
  return {
    pids,
    parentCmd: parent.get(parent.get(pid)?.ppid ?? -1)?.comm ?? "",
  };
}

function fleetRoleSql(): string {
  return `SELECT ${FLEET_ROLE_EXPR.replaceAll("current_database()::text", "$1::text")} AS role`;
}

const OBJECT_IN_USE = "55006";
const TEMPLATE_BUSY_DEADLINE_MS = 60_000;

// This runs before the gate, so its deadlines are the only ones in force: `pg` waits forever by default,
// and an endpoint that accepts the socket and never answers would hang the run before any file loads.
// A statement's wait has to cover the lock while other workers clone, hence the template window, twice.
export type CloneDeadlines = { connectMs: number; queryMs: number };
export const CLONE_DEADLINES: CloneDeadlines = {
  connectMs: CONNECT_ATTEMPT_MS,
  queryMs: TEMPLATE_BUSY_DEADLINE_MS * 2,
};

async function newClient(
  url: string,
  deadlines: CloneDeadlines = CLONE_DEADLINES,
): Promise<Client> {
  const { Client } = await import("pg");
  // A connect that lapses is tried again on a fresh client (see `retryConnect`); the abandoned one
  // keeps a listener, so its socket closing late is not an unhandled error in whichever file runs next.
  return retryConnect(async () => {
    const c = new Client({
      connectionString: url,
      connectionTimeoutMillis: deadlines.connectMs,
      query_timeout: deadlines.queryMs,
      application_name: CLONE_APP,
    });
    c.on("error", () => {});
    try {
      await c.connect();
      return c;
    } catch (err) {
      void c.end().catch(() => {});
      throw err;
    }
  });
}

// The lock is per checkout (the root's hash is in every name it guards), held for the session, and
// released with the connection if the holder dies.
async function withCloneLock<T>(
  maint: Client,
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  await maint.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
    `fazerai-test-clone:${testDbNameFor("x_test", root)}`,
  ]);
  try {
    return await fn();
  } finally {
    await maint
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `fazerai-test-clone:${testDbNameFor("x_test", root)}`,
      ])
      .catch(() => {});
  }
}

// The copy's fleet role is created, granted and dropped under the role catalog lock the suites that
// write roles take (tests/utils/role-catalog-lock.ts), in the same `postgres` session and always after
// the clone lock. Only around that DDL: the wait for a busy template lasts up to a minute, longer than
// any other suite allows itself to wait for this lock.
async function withRoleCatalogLockOn<T>(
  maint: Client,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireRoleCatalogLock(maint);
  try {
    return await fn();
  } finally {
    await maint
      .query("SELECT pg_advisory_unlock($1)", [ROLE_CATALOG_LOCK])
      .catch(() => {});
  }
}

async function listClones(
  maint: Client,
  root: string,
): Promise<{ name: string; comment: string | null }[]> {
  const { rows } = await maint.query<{ name: string; comment: string | null }>(
    `SELECT datname AS name, shobj_description(oid, 'pg_database') AS comment
       FROM pg_database WHERE datname LIKE '%x%'`,
  );
  return rows.filter((r) => isWorkerCloneOf(r.name, root));
}

// A copy goes with the fleet role named after it (cluster-wide, see `provisionClone`). FORCE ends the
// connections of a run killed mid-way whose workers outlived it.
async function dropClone(maint: Client, name: string): Promise<void> {
  const role = (await maint.query<{ role: string }>(fleetRoleSql(), [name]))
    .rows[0]?.role as string;
  await maint.query(
    `DROP DATABASE IF EXISTS ${maint.escapeIdentifier(name)} WITH (FORCE)`,
  );
  // NOTE: a role that cannot go yet (it was granted something elsewhere) is reported, not thrown: a
  // throw here fails the test file that happened to reap, on every run until someone drops it.
  await withRoleCatalogLockOn(maint, () =>
    maint.query(`DROP ROLE IF EXISTS ${maint.escapeIdentifier(role)}`),
  ).catch((err: unknown) =>
    console.warn(
      `tests: could not drop the fleet role "${role}" of the removed database copy "${name}": ${err instanceof Error ? err.message : err}`,
    ),
  );
}

async function reapUnderLock(
  maint: Client,
  root: string,
  template: string,
): Promise<string[]> {
  const rows = await listClones(maint, root);
  const startOf = await startsOf(
    rows.flatMap((r) => {
      const o = parseOwner(r.comment);
      return o ? [o.pid] : [];
    }),
  );
  const doomed = clonesToDrop(rows, { root, template }, startOf);
  for (const name of doomed) await dropClone(maint, name);
  return doomed;
}

export async function reapClones(opts: {
  maintUrl: string;
  root: string;
  template: string;
  deadlines?: CloneDeadlines;
}): Promise<string[]> {
  const maint = await newClient(opts.maintUrl, opts.deadlines);
  try {
    return await withCloneLock(maint, opts.root, () =>
      reapUnderLock(maint, opts.root, opts.template),
    );
  } finally {
    await maint.end().catch(() => {});
  }
}

// The fleet role's name derives from the database's (src/lib/tenancy/fleet-role.ts), so a copy
// resolves to a role nobody created and its policies still name the template's. This is the repair
// `db-guard` prints for a database restored under another name, done up front: the copy's own role,
// the template role's privileges moved to it, its policies pointed at it, and the runtime role made a
// member that may SET ROLE to it without inheriting it, as `scripts/db-bootstrap.ts` provisions.
async function provisionClone(
  cloneUrl: string,
  appRole: string,
  deadlines?: CloneDeadlines,
) {
  const c = await newClient(cloneUrl, deadlines);
  try {
    const fleet = (
      await c.query<{ role: string }>(
        "SELECT public.fazerai_fleet_role() AS role",
      )
    ).rows[0]?.role as string;
    const { rows: policies } = await c.query<{ nsp: string; rel: string }>(
      `SELECT n.nspname AS nsp, cl.relname AS rel FROM pg_policy p
         JOIN pg_class cl ON cl.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE p.polname = 'fleet_super_admin'`,
    );
    const { rows: olds } = await c.query<{ rolname: string }>(
      `SELECT DISTINCT r.rolname FROM pg_policy p
         CROSS JOIN LATERAL unnest(p.polroles) AS pr(oid)
         JOIN pg_roles r ON r.oid = pr.oid
        WHERE p.polname = 'fleet_super_admin' AND r.rolname <> $1`,
      [fleet],
    );
    const version = Number(
      (
        await c.query<{ v: string }>(
          "SELECT current_setting('server_version_num') AS v",
        )
      ).rows[0]?.v,
    );
    const id = (s: string) => c.escapeIdentifier(s);
    const f = id(fleet);
    const exists = (
      await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [fleet])
    ).rowCount;
    const statements = [
      exists
        ? null
        : `CREATE ROLE ${f} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      ...olds.flatMap(({ rolname }) => [
        `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${id(rolname)}`,
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${id(rolname)}`,
        `REVOKE ALL ON SCHEMA public FROM ${id(rolname)}`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${id(rolname)}`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${id(rolname)}`,
      ]),
      ...policies.map(
        (p) =>
          `ALTER POLICY fleet_super_admin ON ${id(p.nsp)}.${id(p.rel)} TO ${f}`,
      ),
      `GRANT USAGE ON SCHEMA public TO ${f}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${f}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${f}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${f}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${f}`,
      version >= 160000
        ? `GRANT ${f} TO ${id(appRole)} WITH INHERIT FALSE, SET TRUE`
        : `GRANT ${f} TO ${id(appRole)}`,
    ].filter((s): s is string => s !== null);
    await c.query(`BEGIN; ${statements.join(";\n")}; COMMIT;`);
  } finally {
    await c.end().catch(() => {});
  }
}

async function createClone(
  maint: Client,
  template: string,
  clone: string,
  owner: CloneOwner,
) {
  const meta = (
    await maint.query<{
      owner: string;
      acl: { grantee: string; priv: string }[] | null;
    }>(
      `SELECT pg_get_userbyid(d.datdba) AS owner,
              (SELECT json_agg(json_build_object(
                        'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                        ELSE pg_get_userbyid(a.grantee) END,
                        'priv', a.privilege_type))
                 FROM aclexplode(d.datacl) a) AS acl
         FROM pg_database d WHERE d.datname = $1`,
      [template],
    )
  ).rows[0];
  if (!meta) throw noTemplate(template);
  const id = (s: string) => maint.escapeIdentifier(s);
  const stopAt = Date.now() + TEMPLATE_BUSY_DEADLINE_MS;
  let pause = 100;
  for (;;) {
    try {
      await maint.query(
        `CREATE DATABASE ${id(clone)} TEMPLATE ${id(template)} OWNER ${id(meta.owner)}`,
      );
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== OBJECT_IN_USE) throw err;
      if (Date.now() >= stopAt) {
        const { rows } = await maint.query<{ who: string }>(
          `SELECT format('pid %s, %s, %s', pid, usename, coalesce(nullif(application_name, ''), '?')) AS who
             FROM pg_stat_activity WHERE datname = $1`,
          [template],
        );
        throw new Error(
          `could not copy "${template}" for this worker: it stayed open by other connections for ${TEMPLATE_BUSY_DEADLINE_MS / 1000}s (${rows.map((r) => r.who).join("; ") || "none listed"}). Under --parallel nothing may connect to the checkout's own test database; a serial \`bun test\` of this checkout running at the same time does.`,
        );
      }
      await Bun.sleep(pause);
      pause = Math.min(pause * 2, 2_000);
    }
  }
  await maint.query(
    `COMMENT ON DATABASE ${id(clone)} IS ${maint.escapeLiteral(ownerComment(owner))}`,
  );
  // NOTE: CREATE DATABASE does not copy the database's own ACL, and the template's grants (the
  // runtime role's CONNECT and CREATE) are what the suite runs with.
  if (meta.acl) {
    const grants = meta.acl.map(
      (a) =>
        `GRANT ${a.priv} ON DATABASE ${id(clone)} TO ${a.grantee === "PUBLIC" ? "PUBLIC" : id(a.grantee)}`,
    );
    await maint.query(
      `REVOKE ALL ON DATABASE ${id(clone)} FROM PUBLIC; ${grants.join("; ")}`,
    );
  }
}

// Watches the `bun test` parent and, once it is gone, removes the copies whose owner is gone: the
// normal end of a run, and a killed one. Detached, so a signal to the run's process group does not
// reach it, and backgrounded by the `sh` it starts, because a parallel worker ends by killing its own
// children, detached or not. The loop costs nothing while it waits; Bun only starts once there is work.
function spawnReaper(opts: {
  ppid: number;
  maintUrl: string;
  root: string;
  template: string;
}) {
  const script = `(while kill -0 ${opts.ppid} 2>/dev/null; do sleep 2; done; exec "$REAP_BUN" "$REAP_FILE") </dev/null >/dev/null 2>&1 &`;
  const child = spawn("sh", ["-c", script], {
    cwd: opts.root,
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      REAP_BUN: process.execPath,
      REAP_FILE: fileURLToPath(import.meta.url),
      TEST_DB_REAP_URL: opts.maintUrl,
      TEST_DB_REAP_ROOT: opts.root,
      TEST_DB_REAP_TEMPLATE: opts.template,
    },
  });
  child.unref();
}

// The worker's copy of `template`, created if needed. `suUrl` is the superuser URL of the template;
// `appRole` is the runtime role the suite's app URL logs in as.
export async function ensureWorkerClone(opts: {
  suUrl: string;
  appRole: string;
  root: string;
  template: string;
  clone: string;
  deadlines?: CloneDeadlines;
}): Promise<void> {
  const { root, template, clone } = opts;
  const maintUrl = withDbName(opts.suUrl, "postgres");
  const maint = await newClient(maintUrl, opts.deadlines);
  try {
    const current = async (): Promise<CloneOwner | null | undefined> => {
      const { rows } = await maint.query<{ comment: string | null }>(
        "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
        [clone],
      );
      return rows.length === 0
        ? undefined
        : parseOwner(rows[0]?.comment ?? null);
    };
    // Every file but the worker's first ends here, without the lock and with one `ps` for the owner's
    // start time, and so does every file of a checkout that has no test database.
    const { rows: probe } = await maint.query<{
      comment: string | null;
      cloned: boolean;
      template: boolean;
    }>(
      `SELECT (SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = $1) AS comment,
              EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS cloned,
              EXISTS (SELECT 1 FROM pg_database WHERE datname = $2) AS template`,
      [clone, template],
    );
    const p = probe[0];
    const recorded = p?.cloned ? parseOwner(p.comment) : undefined;
    const decided = fastPath(
      { template: Boolean(p?.template), clone: recorded },
      { pid: process.pid, ppid: process.ppid },
      await startsOf(recorded?.workerPid === process.pid ? [recorded.pid] : []),
    );
    if (decided === "use") return;
    if (decided === "no-template") throw noTemplate(template);

    // The run is the parent when this is a spawned worker, and this very process when Bun runs
    // the files in-process (`--parallel=1`) or when the parent is gone and the worker was adopted; a
    // copy owned by the process itself is removed when it ends.
    const { pids: ancestors, parentCmd } = await ancestorsOf(process.pid);
    const ownerPid = /(^|\/)bun$/.test(parentCmd) ? process.ppid : process.pid;
    const start = await processStart(ownerPid);
    if (start === null)
      throw new Error(`the \`bun test\` run (pid ${ownerPid}) is gone`);
    const me = { pid: process.pid, ancestors: [process.pid, ...ancestors] };
    let created = false;
    await withCloneLock(maint, root, async () => {
      await reapUnderLock(maint, root, template);
      const existing = await current();
      const startOf = await startsOf(existing ? [existing.pid] : []);
      const verdict = cloneVerdict(existing, me, (pid) =>
        pid === ownerPid ? start : startOf(pid),
      );
      if (verdict === "use") {
        const o = (await current()) as CloneOwner;
        if (o.pid === ownerPid && o.workerPid !== process.pid) {
          await maint.query(
            `COMMENT ON DATABASE ${maint.escapeIdentifier(clone)} IS ${maint.escapeLiteral(ownerComment({ ...o, workerPid: process.pid }))}`,
          );
        }
        return;
      }
      if (verdict === "refuse") {
        const o = (await current()) as CloneOwner;
        throw new Error(
          `"${clone}" belongs to another \`bun test --parallel\` of this checkout that is still running (pid ${o.pid}). Two parallel runs of one checkout would share every worker's database; wait for it to end.`,
        );
      }
      if (verdict === "recreate") await dropClone(maint, clone);
      const owner: CloneOwner = {
        template,
        pid: ownerPid,
        start,
        workerPid: process.pid,
        ready: false,
      };
      await createClone(maint, template, clone, owner);
      await withRoleCatalogLockOn(maint, () =>
        provisionClone(
          withDbName(opts.suUrl, clone),
          opts.appRole,
          opts.deadlines,
        ),
      );
      await maint.query(
        `COMMENT ON DATABASE ${maint.escapeIdentifier(clone)} IS ${maint.escapeLiteral(ownerComment({ ...owner, ready: true }))}`,
      );
      created = true;
    });
    if (created) spawnReaper({ ppid: ownerPid, maintUrl, root, template });
  } finally {
    await maint.end().catch(() => {});
  }
}

if (import.meta.main && process.env.TEST_DB_REAP_URL) {
  await reapClones({
    maintUrl: process.env.TEST_DB_REAP_URL,
    root: process.env.TEST_DB_REAP_ROOT as string,
    template: process.env.TEST_DB_REAP_TEMPLATE as string,
  });
}
