/// <reference lib="dom" />

// The browser's WebSocket, replaced by one the test opens and feeds: every socket the page creates
// is kept in `sockets`, opens on the next microtask, and `deliver` hands it a server message as JSON.
export const sockets: FakeWebSocket[] = [];

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  constructor(readonly url: string) {
    super();
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

const RealWebSocket = globalThis.WebSocket;

export function installFakeWebSocket(): void {
  sockets.length = 0;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

export function restoreWebSocket(): void {
  globalThis.WebSocket = RealWebSocket;
}

// The first socket the page opened, once it is open.
export function openSocket(): FakeWebSocket {
  const s = sockets[0];
  if (s?.readyState !== 1) throw new Error("the socket never opened");
  return s;
}
