import type { Subprocess } from "bun";

// What a test spawned and may have left running: a test that times out keeps running, and so does its
// subprocess, while Bun moves on to `afterEach`. `stopAll` kills whatever is still running and returns
// only once each one has exited, so whatever the caller releases next (a lock the subprocess's work
// was under) is released after that work has stopped.
export class SubprocessTracker {
  private readonly running = new Set<Subprocess>();

  track<T extends Subprocess>(proc: T): T {
    this.running.add(proc);
    void proc.exited.then(
      () => this.running.delete(proc),
      () => this.running.delete(proc),
    );
    return proc;
  }

  async stopAll(): Promise<void> {
    const left = [...this.running];
    for (const proc of left) proc.kill("SIGKILL");
    await Promise.all(left.map((proc) => proc.exited.catch(() => {})));
    for (const proc of left) this.running.delete(proc);
  }
}
