// The rows whose handler is still executing in this process, whatever their status says (issue
// #811). A run ended by its deadline is failed back to PENDING while the handler that ignored its
// signal may still be awaiting something, and a claim that took that row again would run the same
// job twice at once. Every claim in this process leaves these rows out (claimWhere), and a row leaves
// this set when its handler actually returns, not when its run was ended.
//
// Process-local, like the in-flight sets of the lanes, under the same single-replica discipline.

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
