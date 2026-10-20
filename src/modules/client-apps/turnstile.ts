import logger from "@/api/lib/logger";
import { fetchBounded } from "@/lib/outbound";

// The Cloudflare Turnstile check an app may put before a new anonymous session (docs/client-channel.md,
// "Anonymous visitors"). The page solves the challenge with the app's public site key and sends the
// token it got; the server redeems it once against Cloudflare with the app's secret.

export const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5_000;

// Whether Cloudflare accepts this token for this secret. Fails CLOSED: an unreachable Cloudflare, a
// timeout or an answer that does not parse refuses the new session, because a challenge that passes
// whenever it cannot be checked is no challenge. A session the browser already holds renews without
// it, so an outage stops only new visitors.
export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | null,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const { res, body } = await fetchBounded(
      TURNSTILE_VERIFY_URL,
      { method: "POST", body: form },
      { timeoutMs: TURNSTILE_TIMEOUT_MS, cap: 10_000, fetchImpl },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "turnstile verify answered an error");
      return false;
    }
    return (JSON.parse(body.text) as { success?: unknown }).success === true;
  } catch (err) {
    logger.warn({ err }, "turnstile verify failed");
    return false;
  }
}
