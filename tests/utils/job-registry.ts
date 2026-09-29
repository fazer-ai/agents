import {
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";

// THE SCHEDULER'S HANDLER REGISTRY IS PROCESS-GLOBAL, AND A BUN WORKER SHARES ONE PROCESS ACROSS
// TEST FILES. A handler one file installs for a kind another file drives fails THAT file, in the
// full-suite run only, order-dependently. "Put back" has TWO cases and the absent one is the sharp
// half: several kinds have no production handler at all (`WEBHOOK_RETRY` has neither a handler nor
// anything that enqueues it), so a restore that only re-registers a PREVIOUS handler leaves the stub
// installed forever.
export async function withJobHandler<T>(
  kind: string,
  handler: JobHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = getJobHandler(kind);
  registerJobHandler(kind, handler);
  try {
    return await fn();
  } finally {
    if (previous) registerJobHandler(kind, previous);
    else unregisterJobHandler(kind);
  }
}
