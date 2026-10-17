/**
 * Runs a tool under one deadline for the whole invocation. The signal is aborted BEFORE the call is
 * answered as timed out, so a tool still preparing its request sends nothing after that answer, and
 * one already sent is cancelled: the model may retry a booking it was told failed.
 *
 * `cut` is the session's: a call that ends while a tool is still running aborts it the same way, so
 * nothing the tool sends lands after the hangup, nor after shutdown stops waiting for the call.
 */
export function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  cut?: AbortSignal,
): Promise<T> {
  // Asked before the tool runs: one that answers at once would otherwise win the race.
  if (cut?.aborted)
    return Promise.reject(new Error("the call ended before the tool answered"));
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCut: (() => void) | undefined;
  return Promise.race([
    run(deadline.signal),
    new Promise<T>((_, reject) => {
      const stop = (err: Error) => {
        deadline.abort(err);
        reject(err);
      };
      timer = setTimeout(
        () => stop(new Error(`tool timed out after ${ms} ms`)),
        ms,
      );
      if (!cut) return;
      onCut = () => stop(new Error("the call ended before the tool answered"));
      cut.addEventListener("abort", onCut, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    if (onCut) cut?.removeEventListener("abort", onCut);
  });
}
