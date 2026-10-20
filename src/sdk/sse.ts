// Reads the Server-Sent Events the SDK turn streams (docs/client-channel.md, "Progress as a stream"):
// `tool` while server-side tools run, `ping` to keep proxies open, then one `pending`, `done` or
// `error` carrying JSON.

export interface SseEvent {
  event: string;
  data: string;
}

// Splits a stream into events as they arrive. A frame is complete at the blank line, so a chunk
// that ends mid-frame waits for the next.
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n?/g, "\n");
    for (
      let end = buffer.indexOf("\n\n");
      end !== -1;
      end = buffer.indexOf("\n\n")
    ) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
    if (done) {
      const parsed = parseFrame(buffer);
      if (parsed) yield parsed;
      return;
    }
  }
}

export function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && event === "message") return null;
  return { event, data: data.join("\n") };
}
