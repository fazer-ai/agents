// OAuth-popup result watcher shared by GoogleOAuthSection and McpOAuthSection, built on the signals
// that work for these flows: a BroadcastChannel (origin-scoped and independent of the browsing
// context group, the PRIMARY success signal), `window.opener.postMessage` (secondary, often absent
// once the provider's `same-origin` COOP severs the opener link), and a server-status poll (the
// callback persists tokens server-side, so the server is the source of truth). It never reads
// `popup.closed`: that COOP disowns the opener's handle at the cross-origin hop, after which
// `popup.closed` reads `true` while consent is still on screen, tearing the watcher down
// mid-consent. The COOP is the provider's, so it cannot be fixed from our side.

export type OAuthPopupOutcome =
  | { type: "success"; message?: string }
  | { type: "error"; message?: string }
  | { type: "timeout" };

export interface WatchOAuthPopupOptions {
  // BroadcastChannel name the callback page posts on (e.g. "oauth-google", "oauth-mcp").
  channel: string;
  // Message `type` discriminator the callback page tags its message with (e.g. "google-oauth").
  messageType: string;
  // Source-of-truth backstop: resolves true once the credential is connected server-side. Called on
  // an interval; the side effect of also refreshing the UI status is intentional.
  pollStatus?: () => Promise<boolean>;
  // How often to call pollStatus (default 2.5s).
  pollIntervalMs?: number;
  // Upper bound on the wait before resolving `timeout` (default 3 min) — covers an abandoned consent.
  timeoutMs?: number;
}

export interface OAuthPopupWatcher {
  // Resolves exactly once with the first terminal outcome.
  result: Promise<OAuthPopupOutcome>;
  // Tears down listeners/timers WITHOUT resolving `result`. Call on unmount: leaving the awaited
  // promise pending lets its continuation be GC'd instead of running setState post-unmount.
  cancel: () => void;
}

export function watchOAuthPopup(
  opts: WatchOAuthPopupOptions,
): OAuthPopupWatcher {
  const { channel, messageType, pollStatus } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 3 * 60_000;

  let settle: ((o: OAuthPopupOutcome) => void) | null = null;
  const result = new Promise<OAuthPopupOutcome>((resolve) => {
    settle = resolve;
  });

  let done = false;
  const bc = new BroadcastChannel(channel);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  function cleanup() {
    try {
      bc.close();
    } catch {
      // BroadcastChannel may already be closed; ignore.
    }
    window.removeEventListener("message", onMessage);
    if (pollTimer) clearInterval(pollTimer);
    if (deadline) clearTimeout(deadline);
  }

  function finish(o: OAuthPopupOutcome) {
    if (done) return;
    done = true;
    cleanup();
    settle?.(o);
  }

  function handle(data: unknown) {
    const d = data as { type?: string; ok?: boolean; message?: string } | null;
    if (!d || d.type !== messageType) return;
    finish(
      d.ok
        ? { type: "success", message: d.message }
        : { type: "error", message: d.message },
    );
  }

  bc.onmessage = (e) => handle(e.data);

  function onMessage(e: MessageEvent) {
    if (e.origin !== window.location.origin) return;
    handle(e.data);
  }
  window.addEventListener("message", onMessage);

  if (pollStatus) {
    pollTimer = setInterval(async () => {
      if (done) return;
      try {
        if (await pollStatus()) finish({ type: "success" });
      } catch {
        // Transient; keep polling until the deadline.
      }
    }, pollIntervalMs);
  }

  deadline = setTimeout(() => finish({ type: "timeout" }), timeoutMs);

  function cancel() {
    if (done) return;
    done = true;
    cleanup();
  }

  return { result, cancel };
}
