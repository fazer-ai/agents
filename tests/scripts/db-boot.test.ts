import { describe, expect, test } from "bun:test";
import {
  bootWaitMs,
  DEFAULT_BOOT_WAIT_MS,
  migrateConnectionLoss,
  migrateDeploy,
  TransientStepError,
  targetOf,
  untilReachable,
  withConnectTimeout,
} from "../../scripts/db-boot";

// The image's boot waits for a database that is not reachable yet instead of exiting at the first
// refused connection, which is what turns a database restart into a container restart loop.

function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
    code: "ECONNREFUSED",
  });
}

function clock() {
  let t = 0;
  const pauses: number[] = [];
  const lines: string[] = [];
  return {
    pauses,
    lines,
    now: () => t,
    sleep: async (ms: number) => {
      pauses.push(ms);
      t += ms;
    },
    log: (line: string) => lines.push(line),
  };
}

describe("untilReachable", () => {
  test("retries a refused connection with a doubling pause and returns what the step returns", async () => {
    const c = clock();
    let calls = 0;
    const out = await untilReachable(
      "db-bootstrap",
      async () => {
        calls++;
        if (calls < 4) throw refused();
        return "done";
      },
      { deadlineMs: 60_000, target: "db:5432/app", ...c },
    );
    expect({ out, calls, pauses: c.pauses }).toEqual({
      out: "done",
      calls: 4,
      pauses: [1_000, 2_000, 4_000],
    });
    expect(c.lines).toHaveLength(3);
    expect(c.lines[0]).toContain("db:5432/app");
    expect(c.lines[0]).toContain("ECONNREFUSED");
  });

  test("the pause stops doubling at 5s", async () => {
    const c = clock();
    let calls = 0;
    await untilReachable(
      "s",
      async () => {
        if (++calls < 7) throw refused();
      },
      { deadlineMs: 600_000, target: "t", ...c },
    );
    expect(c.pauses).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
  });

  test("each lost-connection shape is waited on: a server shutting down, starting up, a socket closed without a message, one a step explains in its own words", async () => {
    for (const err of [
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
      Object.assign(new Error("the database system is starting up"), {
        code: "57P03",
      }),
      new Error("Connection terminated unexpectedly"),
      new AggregateError([refused(), refused()], ""),
      new TransientStepError("prisma migrate deploy exited 1 (P1001)"),
      new Error(
        "runtime role is SUPERUSER, and this role cannot take that away",
        {
          cause: Object.assign(new Error("terminating connection"), {
            code: "57P01",
          }),
        },
      ),
    ]) {
      const c = clock();
      let calls = 0;
      await untilReachable(
        "s",
        async () => {
          if (++calls === 1) throw err;
        },
        { deadlineMs: 60_000, target: "t", ...c },
      );
      expect({ err: String(err), calls }).toEqual({
        err: String(err),
        calls: 2,
      });
    }
  });

  test("any other failure is thrown at once, with no wait (catches a bad password retried for two minutes)", async () => {
    const c = clock();
    const auth = Object.assign(new Error("password authentication failed"), {
      code: "28P01",
    });
    await expect(
      untilReachable(
        "s",
        async () => {
          throw auth;
        },
        { deadlineMs: 60_000, target: "t", ...c },
      ),
    ).rejects.toBe(auth);
    expect(c.pauses).toEqual([]);
  });

  test("gives up at the deadline, naming the target, the setting and the last error", async () => {
    const c = clock();
    await expect(
      untilReachable(
        "s",
        async () => {
          throw refused();
        },
        { deadlineMs: 10_000, target: "db:5432/app", ...c },
      ),
    ).rejects.toThrow(
      /the database at db:5432\/app was not reached within 10s \(DB_BOOT_WAIT_MS\); last error: ECONNREFUSED/,
    );
    expect(c.pauses).toEqual([1_000, 2_000, 4_000, 3_000]);
  });

  test("no retry starts once the wait has run out, even when the pause ended late (catches a step started past the deadline)", async () => {
    const c = clock();
    let calls = 0;
    const late = async (ms: number) => {
      c.pauses.push(ms);
      await c.sleep(ms + 500);
      c.pauses.pop();
    };
    await expect(
      untilReachable(
        "s",
        async () => {
          calls++;
          throw refused();
        },
        { deadlineMs: 3_000, target: "t", now: c.now, sleep: late, log: c.log },
      ),
    ).rejects.toThrow(/not reached within 3s/);
    // NOTE: tries at 0 and 1.5s (the 1s pause ended 0.5s late); the next pause ends at 3.5s, past 3s.
    expect(calls).toBe(2);
  });

  test("the deadline is shared by the steps of one boot", async () => {
    const c = clock();
    const opts = { deadlineMs: 5_000, target: "t", startedAt: 0, ...c };
    let calls = 0;
    await untilReachable(
      "first",
      async () => {
        if (++calls < 3) throw refused();
      },
      opts,
    );
    await expect(
      untilReachable(
        "second",
        async () => {
          throw refused();
        },
        opts,
      ),
    ).rejects.toThrow(/not reached within 5s/);
    expect(c.pauses).toEqual([1_000, 2_000, 1_000, 1_000]);
  });
});

describe("migrate output", () => {
  test("reads the codes prisma prints for an unreachable or lost database, and nothing else", () => {
    expect(
      migrateConnectionLoss(
        "Error: P1001: Can't reach database server at `localhost:5473`",
      ),
    ).toBe("P1001");
    expect(
      migrateConnectionLoss("Error: P1017: Server has closed the connection."),
    ).toBe("P1017");
    expect(
      migrateConnectionLoss(
        "Error: P3009: migrate found failed migrations in the target database",
      ),
    ).toBeNull();
    expect(
      migrateConnectionLoss('ERROR: column "x" of relation "y" already exists'),
    ).toBeNull();
  });
});

describe("migrateDeploy", () => {
  test("a run that could not reach the database is waited on; a failed migration is not", async () => {
    const run = (code: number, output: string) => async () => ({
      code,
      output,
    });
    await expect(
      migrateDeploy(run(0, "No pending migrations")),
    ).resolves.toBeUndefined();
    const lost = await migrateDeploy(
      run(1, "Error: P1001: Can't reach database server at `db:5432`"),
    ).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(TransientStepError);
    const failed = await migrateDeploy(
      run(1, "Error: P3018: A migration failed to apply."),
    ).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(TransientStepError);
  });
});

describe("withConnectTimeout", () => {
  test("sets Prisma's connect bound on the migrate URL, replacing one already there, placeholder ports included", () => {
    expect(withConnectTimeout("postgres://u:p@h:5432/db", 4.2)).toBe(
      "postgres://u:p@h:5432/db?connect_timeout=5",
    );
    expect(
      withConnectTimeout("postgres://u:p@h:5432/db?sslmode=require", 10),
    ).toBe("postgres://u:p@h:5432/db?sslmode=require&connect_timeout=10");
    expect(
      withConnectTimeout(
        "postgres://u:p@h:5432/db?connect_timeout=0&sslmode=require",
        3,
      ),
    ).toBe("postgres://u:p@h:5432/db?connect_timeout=3&sslmode=require");
    expect(withConnectTimeout("postgres://u:p@h/db?sslmode=require#x", 2)).toBe(
      "postgres://u:p@h/db?sslmode=require&connect_timeout=2#x",
    );
    expect(withConnectTimeout("postgres://u:p@h/db#connect_timeout=0", 2)).toBe(
      "postgres://u:p@h/db?connect_timeout=2#connect_timeout=0",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${POSTGRES_PORT} placeholder from .env.
    const placeholder = "postgres://u:p@localhost:${POSTGRES_PORT}/db";
    expect(withConnectTimeout(placeholder, 0.2)).toBe(
      `${placeholder}?connect_timeout=1`,
    );
  });
});

describe("DB_BOOT_WAIT_MS", () => {
  test("defaults when unset, and refuses what is not a whole positive number by name", () => {
    expect(bootWaitMs(undefined)).toBe(DEFAULT_BOOT_WAIT_MS);
    expect(bootWaitMs("")).toBe(DEFAULT_BOOT_WAIT_MS);
    expect(bootWaitMs("30000")).toBe(30_000);
    for (const raw of ["0", "-1", "2m", "1.5", "1e309"]) {
      expect(() => bootWaitMs(raw)).toThrow(/^DB_BOOT_WAIT_MS must be/);
    }
  });

  test("the target in the log carries no credentials", () => {
    expect(targetOf("postgres://postgres:s3cret@dbhost:6543/app")).toBe(
      "dbhost:6543/app",
    );
  });
});

const CHILD_BOUND_MS = 15_000;

describe("the boot script against a server that accepts the socket and never answers", () => {
  test("bounds each connect by the wait, and still exits 1 at DB_BOOT_WAIT_MS (catches a boot stuck forever on one connect)", async () => {
    const silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const url = `postgres://postgres:x@localhost:${silent.port}/silent`;
      const started = performance.now();
      const proc = Bun.spawn(["bun", "scripts/db-boot.ts"], {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: url,
          DATABASE_URL: `postgres://app:x@localhost:${silent.port}/silent`,
          DB_BOOT_WAIT_MS: "2500",
        },
        stdout: "pipe",
        stderr: "pipe",
        // NOTE: a boot stuck on the connect never exits on its own.
        timeout: CHILD_BOUND_MS,
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const elapsed = performance.now() - started;
      expect({
        code,
        last: (out + err).trim().split("\n").at(-1),
      }).toMatchObject({
        code: 1,
        last: expect.stringMatching(/was not reached within 2\.5s/),
      });
      expect(elapsed).toBeGreaterThanOrEqual(2_500);
      expect(elapsed).toBeLessThan(12_000);
    } finally {
      silent.stop(true);
    }
  }, 20_000);
});

describe("the boot script against a database that never answers", () => {
  test("waits out DB_BOOT_WAIT_MS with a line per attempt, then exits 1 saying the database was not reached", async () => {
    const closed = "postgres://postgres:x@localhost:9/nowhere";
    const started = performance.now();
    const proc = Bun.spawn(["bun", "scripts/db-boot.ts"], {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: closed,
        DATABASE_URL: "postgres://app:x@localhost:9/nowhere",
        DB_BOOT_WAIT_MS: "2500",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const elapsed = performance.now() - started;
    const lines = (out + err).trim().split("\n");
    expect(code).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(
      lines.filter((l) => l.includes("is not reachable")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(lines.at(-1)).toMatch(
      /^db-boot: the database at localhost:9\/nowhere was not reached within 2\.5s/,
    );
  }, 20_000);
});
