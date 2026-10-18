import type { MailProvider } from "@/config";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  // Resend deduplicates on this key for 24h, which is what makes its
  // retries safe. `sendMail` generates one per message when the caller does
  // not pass its own; pass a stable one (e.g. `password-reset:<userId>:<iat>`)
  // when the same logical message may be sent again by a later job run.
  idempotencyKey?: string;
}

export interface OutgoingMail extends MailMessage {
  from: string;
}

export interface MailTransport {
  readonly provider: MailProvider;
  send(message: OutgoingMail): Promise<{ id: string | null }>;
}

// `retryable` tells a caller with its own retry loop (a job queue, a
// cron) whether trying again later can help. The transports have already
// retried what is safe to retry inline by the time this is thrown.
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly provider: MailProvider,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MailDeliveryError";
  }
}
