import { AsyncLocalStorage } from "node:async_hooks";
import { withDeadline } from "@/lib/outbound";

// The deadline of the tool call a WhatsApp call is running, for every request that tool makes. A
// call's tool runs under one deadline for the whole invocation (`withDeadline` in tool-deadline):
// past it the call has already told the model the tool failed, so a request still being prepared must
// not leave, and one that left is cancelled. Aborting the invoke does not stop a handler mid-way, so
// the deadline rides on the requests themselves: the outbound tools' fetch (HTTP tools, toolpacks) and
// the Chatwoot client's (the native tools' writes). A context rather than a parameter, because the
// toolset is built once per call and the deadline is per invocation.

const current = new AsyncLocalStorage<AbortSignal>();

/** Runs one tool invocation under its deadline. */
export function withinInvocation<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return signal ? current.run(signal, run) : run();
}

/** A fetch that refuses to send past the running invocation's deadline and cancels what it sent. */
export function invocationDeadlineFetch(
  inner: typeof fetch = fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const deadline = current.getStore();
    if (!deadline) return inner(input, init);
    // Thrown rather than answered: every caller reads a transport error as the call not happening.
    if (deadline.aborted)
      throw new Error("the tool's deadline passed before the request was sent");
    return inner(input, {
      ...(init ?? {}),
      signal: withDeadline(init?.signal, deadline),
    });
  }) as typeof fetch;
}
