// Counting semaphore: bounds how many async operations run at once (the agent model calls,
// src/graph/model-limit.ts). A released permit goes straight to the next waiter, FIFO within a class:
// `reply`, a call someone waits on, or `background`, one nobody waits on this second. Under contention
// the oldest reply goes first, except a background waiter past `agingMs`, or any while the background
// holds fewer than `backgroundMin`: maintenance is delayed, never starved. A free permit goes to any
// class at once, so nothing is reserved and callers that name no class get a plain FIFO
// (docs/deploy.md).

export type PermitClass = "reply" | "background";

export interface SemaphorePolicy {
  // Permits the background is served ahead of replies until it holds. 0: no share, aging only.
  backgroundMin?: number;
  // How long a background waiter yields to replies before it is served ahead of them.
  agingMs?: number;
  now?: () => number;
}

interface Waiter {
  cls: PermitClass;
  joinedAt: number;
  grant: () => void;
}

export interface ClassReading {
  held: number;
  waiting: number;
  // How long the head of this class's queue has waited, in ms; 0 with nobody queued.
  oldestWaitMs: number;
}

export class Semaphore {
  private available: number;
  // The permits it was built with, so a reading can say how many are taken.
  readonly permits: number;
  private readonly queues: Record<PermitClass, Waiter[]> = {
    reply: [],
    background: [],
  };
  private readonly held: Record<PermitClass, number> = {
    reply: 0,
    background: 0,
  };
  private readonly freed = new Set<() => void>();
  private readonly backgroundMin: number;
  private readonly agingMs: number;
  private readonly now: () => number;
  // Whether the last contended grant went to an aged background call ahead of a reply.
  private agedLast = false;

  constructor(permits: number, policy: SemaphorePolicy = {}) {
    this.permits = Math.max(1, Math.floor(permits));
    this.available = this.permits;
    this.backgroundMin = Math.max(0, Math.floor(policy.backgroundMin ?? 0));
    this.agingMs = policy.agingMs ?? Number.POSITIVE_INFINITY;
    this.now = policy.now ?? Date.now;
  }

  // A waiter whose `signal` aborts leaves the queue with the signal's reason and takes no permit:
  // removed from its class's queue, so the next release goes to whoever is next. An abort
  // after the permit was granted changes nothing, since the task is already running.
  private acquire(cls: PermitClass, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.available > 0) {
      this.available -= 1;
      this.held[cls] += 1;
      this.agedLast = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        cls,
        joinedAt: this.now(),
        grant: () => {
          signal?.removeEventListener("abort", leave);
          resolve();
        },
      };
      const leave = () => {
        const queue = this.queues[cls];
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", leave, { once: true });
      this.queues[cls].push(waiter);
    });
  }

  // Who gets a freed permit. A reply, unless the background is owed it: the class holds less than
  // its share, or its head has aged past the bound. An aged head goes ahead of a reply only when the
  // grant before this one did not, so a backlog of aged calls takes turns with the replies instead of
  // every permit; any other grant, and a permit going back free, clears that.
  private next(): Waiter | undefined {
    const aged = this.agedLast;
    this.agedLast = false;
    const bg = this.queues.background[0];
    if (!bg) return this.queues.reply.shift();
    if (
      this.queues.reply.length === 0 ||
      this.held.background < this.backgroundMin
    ) {
      return this.queues.background.shift();
    }
    if (!aged && this.now() - bg.joinedAt >= this.agingMs) {
      this.agedLast = true;
      return this.queues.background.shift();
    }
    return this.queues.reply.shift();
  }

  private release(cls: PermitClass): void {
    this.held[cls] -= 1;
    const next = this.next();
    if (next) {
      // NOTE: hand the permit straight to the next waiter; do NOT bump `available` (it already holds it).
      this.held[next.cls] += 1;
      next.grant();
    } else {
      this.available += 1;
      for (const listener of [...this.freed]) listener();
    }
  }

  // How many permits a `tryAcquire` would get right now.
  get free(): number {
    return this.available;
  }

  // How many callers are queued for a permit right now, both classes.
  get waiting(): number {
    return this.queues.reply.length + this.queues.background.length;
  }

  // Held, queued and the oldest wait, per class: what shows a class being starved.
  classReading(): Record<PermitClass, ClassReading> {
    const now = this.now();
    const of = (cls: PermitClass): ClassReading => {
      const head = this.queues[cls][0];
      return {
        held: this.held[cls],
        waiting: this.queues[cls].length,
        oldestWaitMs: head ? Math.max(0, now - head.joinedAt) : 0,
      };
    };
    return { reply: of("reply"), background: of("background") };
  }

  // Calls `listener` each time a permit becomes free with nobody queued for it, until the returned
  // function is called. For a caller that only ever `tryAcquire`s and must learn when to try again.
  onFree(listener: () => void): () => void {
    this.freed.add(listener);
    return () => {
      this.freed.delete(listener);
    };
  }

  // Takes a permit only if one is free right now, never joining the queue. Returns its release
  // (idempotent), or null. For a caller that must not commit to work it cannot start at once.
  tryAcquire(cls: PermitClass = "reply"): (() => void) | null {
    if (this.available <= 0) return null;
    this.available -= 1;
    this.held[cls] += 1;
    this.agedLast = false;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(cls);
    };
  }

  async run<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    cls: PermitClass = "reply",
  ): Promise<T> {
    await this.acquire(cls, signal);
    try {
      return await fn();
    } finally {
      this.release(cls);
    }
  }
}
