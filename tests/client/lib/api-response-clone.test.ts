import { describe, expect, test } from "bun:test";
import { onApiResponse } from "@/client/lib/api";

// Eden hands the response hook a clone and reads the original. A clone whose body is left open buffers
// every chunk the original receives: on a dashboard stream that runs for minutes, every snapshot. The
// hook reads only headers and status, so it cancels the clone's body at once.

describe("the API client's response hook", () => {
  test("cancels the body of the response it is handed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("event: snapshot\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    onApiResponse(
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
});
