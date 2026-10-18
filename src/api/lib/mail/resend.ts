import {
  MailDeliveryError,
  type MailTransport,
  type OutgoingMail,
} from "@/api/lib/mail/types";

const RESEND_API_URL = "https://api.resend.com/emails";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 5_000;

// retried by Resend's error NAME, not by status, because a status does
// not decide it: a 429 is `rate_limit_exceeded` (wait and retry) or
// `daily_quota_exceeded` (retrying until tomorrow only burns the request
// budget), and a 409 is a concurrent request on the same idempotency key
// (retry) or a key reused with a different body (never). Source: the error
// table at https://resend.com/docs/api-reference/errors. An unknown name with
// a 5xx status is still retried.
const RETRYABLE_ERROR_NAMES = new Set([
  "rate_limit_exceeded",
  "application_error",
  "service_unavailable",
  "concurrent_idempotent_requests",
  "resource_locked",
]);

interface ResendErrorBody {
  statusCode?: number;
  name?: string;
  message?: string;
}

export interface ResendTransportOptions {
  apiKey: string;
  fetch?: typeof fetch;
  // injectable so tests do not sleep through the backoff.
  sleep?: (ms: number) => Promise<void>;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** attempt;
  return Math.min(Math.max(delay, 0), MAX_RETRY_DELAY_MS);
}

// the HTTP API directly, not the `resend` SDK: a single POST is all a
// transactional send needs, and the SDK would be a dependency (and an API
// surface) to keep current for that. A derived project that wants batch
// sends, audiences or webhooks can add it next to this.
export function createResendTransport({
  apiKey,
  fetch: fetchImpl = fetch,
  sleep = Bun.sleep,
}: ResendTransportOptions): MailTransport {
  return {
    provider: "resend",
    async send(message: OutgoingMail) {
      const body = JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      });

      let lastFailure: MailDeliveryError | undefined;
      let lastRetryAfter: string | null = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0 && lastFailure) {
          await sleep(retryDelayMs(attempt - 1, lastRetryAfter));
        }
        let response: Response;
        try {
          response = await fetchImpl(RESEND_API_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              // the same key on every attempt is what makes a retry
              // after a timeout safe: if the first request did land, Resend
              // answers the retry with the original result instead of sending
              // the message twice.
              ...(message.idempotencyKey
                ? { "Idempotency-Key": message.idempotencyKey }
                : {}),
            },
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          lastRetryAfter = null;
          lastFailure = new MailDeliveryError(
            `Resend request failed: ${error instanceof Error ? error.message : String(error)}`,
            "resend",
            true,
          );
          continue;
        }

        if (response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            id?: string;
          };
          return { id: data.id ?? null };
        }

        const data = (await response
          .json()
          .catch(() => ({}))) as ResendErrorBody;
        // Any 5xx is the provider's own trouble, named or not ("internal_server_error" is not on the
        // list), so it is retried; a 4xx only when its name says it is transient (a rate limit).
        const retryable =
          response.status >= 500 ||
          (data.name !== undefined && RETRYABLE_ERROR_NAMES.has(data.name));
        lastRetryAfter = response.headers.get("retry-after");
        lastFailure = new MailDeliveryError(
          `Resend rejected the message (${response.status} ${data.name ?? "unknown"}): ${data.message ?? response.statusText}`,
          "resend",
          retryable,
          response.status,
        );
        if (!retryable) throw lastFailure;
      }
      throw lastFailure as MailDeliveryError;
    },
  };
}
