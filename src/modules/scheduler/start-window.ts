// How many jobs a drain may START in any window of `windowMs`: the sustained ceiling of the traffic
// drain (./worker.ts, runTrafficTick), whose concurrency alone does not bound its rate (a lane of
// fast jobs at five at a time is hundreds a minute). Process-local, as the drain is. A start at `t`
// counts until `t + windowMs` inclusive, so no closed window of `windowMs` holds more than `max`.
export class StartWindow {
  private readonly starts: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
  ) {}

  private prune(now: number): void {
    const kept = this.starts.findIndex((t) => t >= now - this.windowMs);
    this.starts.splice(0, kept === -1 ? this.starts.length : kept);
  }

  available(now: number): number {
    this.prune(now);
    return Math.max(0, this.max - this.starts.length);
  }

  record(now: number, count: number): void {
    for (let i = 0; i < count; i++) this.starts.push(now);
  }

  // The first instant `available` is above zero again.
  nextFreeAt(now: number): number {
    this.prune(now);
    const holding = this.starts[this.starts.length - this.max];
    return holding === undefined ? now : holding + this.windowMs + 1;
  }
}
