import {
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";

// THE SCHEDULER'S HANDLER REGISTRY IS PROCESS-GLOBAL, AND A BUN WORKER SHARES ONE PROCESS ACROSS
// TEST FILES.
//
// A handler installed by one file for a kind another file drives is a poisoning that surfaces as
// THEIR failure, in the full-suite run only, order-dependently. Measured twice while writing issue
// #356: a throwing `RAG_INGEST` left behind took five tests in rag-ingest-stale-publish.test.ts with
// it, and a leaked `WEBHOOK_RETRY` from scheduler.test.ts made a test here read a handler it had not
// installed.
//
// "Put back" has TWO cases and the absent one is the sharp half — several kinds have no production
// handler at all (`WEBHOOK_RETRY` has neither a handler nor anything that enqueues it), so a restore
// that only re-registers a PREVIOUS handler leaves the stub installed forever. Three files were
// written with exactly that hole before this helper existed.
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
