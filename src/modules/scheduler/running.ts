// The rows whose handler is still executing in this process, whatever their status says. A run
// ended by its deadline goes back to PENDING while its handler may still be awaiting something, so
// every claim in this process leaves these rows out (claimWhere), and a row leaves this set only when
// its handler returns. Process-local, under the same single-replica discipline as the lanes.

const running = new Set<bigint>();

export function markRunning(id: bigint): void {
  running.add(id);
}

export function markSettled(id: bigint): void {
  running.delete(id);
}

export function runningJobIds(): bigint[] {
  return [...running];
}
