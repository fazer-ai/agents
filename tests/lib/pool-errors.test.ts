import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import logger from "@/api/lib/logger";
import { absorbPoolErrors } from "@/lib/pool-errors";

// What a dropped connection logs, per shape the server drops it in. The events are the ones `pg`
// emits on a pool and on its clients; tests/lib/pool-terminate.test.ts drives a real server.

function guarded(name: string): { pool: EventEmitter; client: EventEmitter } {
  const pool = new EventEmitter();
  absorbPoolErrors(name, pool as unknown as Pool);
  const client = new EventEmitter();
  pool.emit("connect", client);
  return { pool, client };
}

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

function capture() {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  restore.push(
    () => warn.mockRestore(),
    () => error.mockRestore(),
  );
  return { warn, error };
}

describe("absorbPoolErrors", () => {
  test("a shutdown's 57P01 is a warn naming the pool and the SQLSTATE", () => {
    const { warn, error } = capture();
    const { client } = guarded("main");
    client.emit(
      "error",
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      pool: "main",
      sqlstate: "57P01",
    });
    expect(error).not.toHaveBeenCalled();
  });

  test("a crash of another backend names 57P02, which only its WARNING notice carried (catches 'none' on a crash shutdown)", () => {
    const { warn } = capture();
    const { client } = guarded("checkpointer");
    client.emit("notice", {
      code: "57P02",
      message:
        "terminating connection because of crash of another server process",
    });
    client.emit("error", new Error("Connection terminated unexpectedly"));
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      pool: "checkpointer",
      sqlstate: "57P02",
    });
  });

  test("an ordinary notice does not become the SQLSTATE of a later drop", () => {
    const { warn } = capture();
    const { client } = guarded("ack");
    client.emit("notice", {
      code: "42P07",
      message: "relation already exists",
    });
    client.emit("error", new Error("Connection terminated unexpectedly"));
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      pool: "ack",
      sqlstate: "none",
    });
  });

  test("a failure that is not a lost connection is an error, and still does not throw", () => {
    const { warn, error } = capture();
    const { pool, client } = guarded("metrics");
    const odd = Object.assign(new Error("protocol violation"), {
      code: "08P01",
    });
    expect(() => client.emit("error", odd)).not.toThrow();
    expect(() => pool.emit("error", odd)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      pool: "metrics",
      sqlstate: "08P01",
    });
  });
});
