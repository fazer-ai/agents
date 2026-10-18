import nodemailer from "nodemailer";
import {
  MailDeliveryError,
  type MailTransport,
  type OutgoingMail,
} from "@/api/lib/mail/types";

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
}

// SMTP is the convenience path (Mailpit in dev, a provider that only
// speaks SMTP, an existing relay). It has no idempotency key, so nothing here
// retries: a timeout after DATA may well have delivered, and a blind retry is a
// duplicate in the recipient's inbox. Connection-level failures before the
// server accepted anything are reported as retryable for a caller with its
// own queue.
export function createSmtpTransport(
  options: SmtpTransportOptions,
): MailTransport {
  const transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.user
      ? { auth: { user: options.user, pass: options.password ?? "" } }
      : {}),
    // nodemailer's defaults are 2 minutes for the connection and 10 for
    // the socket, long enough to pin a request worker on an unreachable host.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return {
    provider: "smtp",
    async send(message: OutgoingMail) {
      try {
        const info = await transporter.sendMail({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        });
        return { id: info.messageId ?? null };
      } catch (error) {
        const code = (error as { code?: string }).code;
        const responseCode = (error as { responseCode?: number }).responseCode;
        throw new MailDeliveryError(
          `SMTP send failed${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
          "smtp",
          // ECONNECTION/ESOCKET/ETIMEDOUT/EDNS are transport failures
          // (a refused connection surfaces as ESOCKET); a 4xx reply is a
          // temporary refusal by definition (RFC 5321). EAUTH and 5xx are not:
          // retrying a wrong password or a rejected recipient changes nothing.
          code === "ECONNECTION" ||
            code === "ESOCKET" ||
            code === "ETIMEDOUT" ||
            code === "EDNS" ||
            (responseCode !== undefined &&
              responseCode >= 400 &&
              responseCode < 500),
          responseCode,
        );
      }
    },
  };
}
