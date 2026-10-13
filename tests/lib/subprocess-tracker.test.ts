import { describe, expect, test } from "bun:test";
import { SubprocessTracker } from "@/tests/utils/subprocess-tracker";

// A test that times out keeps running, and so does whatever it spawned, while Bun moves on to the
// `afterEach`. A suite that holds a lock for its subprocess's sake has to stop the subprocess, and
// see it gone, before it lets the lock go (tests/scripts/db-bootstrap.test.ts).
describe("stopping what a test spawned", () => {
  test("a subprocess still running is killed, and has exited by the time stopAll returns", async () => {
    const tracker = new SubprocessTracker();
    const proc = tracker.track(Bun.spawn(["sleep", "30"]));
    await tracker.stopAll();
    // Read without awaiting `exited`: only a stopAll that waited for the exit has set it already.
    expect(proc.signalCode).not.toBeNull();
  });

  test("one that already finished is left alone", async () => {
    const tracker = new SubprocessTracker();
    const proc = tracker.track(Bun.spawn(["true"]));
    await proc.exited;
    await tracker.stopAll();
    expect(proc.exitCode).toBe(0);
    expect(proc.signalCode).toBeNull();
  });
});
