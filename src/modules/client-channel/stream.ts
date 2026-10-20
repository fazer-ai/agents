// A client turn as Server-Sent Events, for a host that asked for `text/event-stream`: one `tool`
// event per server-side tool as it starts and ends, then the turn's own result as a `pending` or
// `done` event, in the same shape the JSON answer has. The JSON answer stays the contract; this only
// lets the page say "searching..." while the turn runs.
//
// A refusal raised before the first event (unknown thread, wrong user, spend ceiling) still answers
// with its own status, because Elysia waits for the first event before it sends the headers. One
// raised after that can no longer change the status, so it arrives as an `error` event.

import { sse } from "elysia";
import logger from "@/api/lib/logger";
import { refusalBody } from "@/api/lib/refusal";
import { AppError } from "@/lib/errors";
import type { ClientTurnEvent } from "./progress";
import type { ClientTurnResult } from "./service";

// A proxy in front (Traefik, Cloudflare at about 100 seconds) closes a response that stays silent too
// long, and a model call alone can take longer than that. Bun's own idle timeout does not count these
// writes, which is why the route turns it off for the request.
const HEARTBEAT_MS = 15_000;

type Outcome =
  | { ok: true; result: ClientTurnResult }
  | { ok: false; error: unknown };

function errorEvent(error: unknown, acceptLanguage: string | null) {
  if (error instanceof AppError)
    return {
      status: error.statusCode,
      ...refusalBody(error, acceptLanguage),
    };
  logger.error("client turn stream\n%s", error);
  return { status: 500, error: "Internal Server Error" };
}

// Awaited by the route before it answers: until the turn emits its first event, ends, or the first
// heartbeat is due, nothing has been sent, so a refusal is thrown as the route's own and keeps its
// status. Elysia does not route an error thrown by a stream's first chunk through `onError`.
export async function streamClientTurn(
  run: (onEvent: (event: ClientTurnEvent) => void) => Promise<ClientTurnResult>,
  opts: { acceptLanguage: string | null; heartbeatMs?: number },
) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const queue: ClientTurnEvent[] = [];
  let outcome: Outcome | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  run((event) => {
    queue.push(event);
    notify();
  })
    .then(
      (result) => {
        outcome = { ok: true, result };
      },
      (error: unknown) => {
        outcome = { ok: false, error };
      },
    )
    .finally(notify);

  // Resolves true when the heartbeat is due before anything else happened.
  const next = async () => {
    if (queue.length || outcome) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beat = await new Promise<boolean>((resolve) => {
      wake = () => resolve(false);
      timer = setTimeout(() => resolve(true), heartbeatMs);
    });
    clearTimeout(timer);
    wake = undefined;
    return beat;
  };

  let beat = await next();
  if (outcome && !outcome.ok && !queue.length) throw outcome.error;

  return (async function* () {
    for (;;) {
      if (beat) yield sse({ event: "ping", data: "" });
      for (let event = queue.shift(); event; event = queue.shift())
        yield sse({ event: "tool", data: event });
      if (outcome?.ok) {
        yield sse({ event: outcome.result.status, data: outcome.result });
        return;
      }
      if (outcome) {
        yield sse({
          event: "error",
          data: errorEvent(outcome.error, opts.acceptLanguage),
        });
        return;
      }
      beat = await next();
    }
  })();
}
