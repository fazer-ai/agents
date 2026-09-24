// Counting semaphore: bounds how many async operations run at once. Used to cap concurrent agent
// model calls process-wide (see src/graph/model-limit.ts) without serializing the rest of the
// conversation pipeline. FIFO — a released permit is handed straight to the next waiter.

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  // A waiter whose `signal` aborts leaves the queue with the signal's reason and takes no permit
  // (issue #834): removed from the queue, so the next release goes to whoever is behind it. An abort
  // after the permit was granted changes nothing, since the task is already running.
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        const at = this.waiters.indexOf(grant);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", leave, { once: true });
      this.waiters.push(grant);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // NOTE: hand the permit straight to the next waiter; do NOT bump `available` (it already holds it).
      next();
    } else {
      this.available += 1;
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
