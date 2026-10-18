import { randomUUID } from "node:crypto";
import logger from "@/api/lib/logger";
import {
  createConsoleTransport,
  createMemoryTransport,
} from "@/api/lib/mail/dev";
import { createResendTransport } from "@/api/lib/mail/resend";
import { createSmtpTransport } from "@/api/lib/mail/smtp";
import {
  MailDeliveryError,
  type MailMessage,
  type MailTransport,
} from "@/api/lib/mail/types";
import config, { type MailProvider } from "@/config";

export { clearMailOutbox, mailOutbox } from "@/api/lib/mail/dev";
export { MailDeliveryError, type MailMessage } from "@/api/lib/mail/types";

let cached: {
  provider: MailProvider;
  transport: MailTransport | null;
} | null = null;

// built on first send, and rebuilt when `config.mail.provider` changes,
// so a test that flips the provider gets the matching transport and importing
// this module never opens an SMTP connection.
function getTransport(): MailTransport | null {
  const { provider } = config.mail;
  if (cached?.provider === provider) return cached.transport;
  let transport: MailTransport | null;
  switch (provider) {
    case "resend":
      transport = createResendTransport({ apiKey: config.mail.resendApiKey });
      break;
    case "smtp":
      transport = createSmtpTransport(config.mail.smtp);
      break;
    case "console":
      transport = createConsoleTransport();
      break;
    case "memory":
      transport = createMemoryTransport();
      break;
    case "none":
      transport = null;
      break;
  }
  cached = { provider, transport };
  return transport;
}

export function isMailEnabled(): boolean {
  return config.mail.enabled;
}

// throws MailDeliveryError when the provider refuses the message or is
// unreachable, and when mail is disabled. Callers on a request path that must
// not reveal the outcome (forgot password) fire it without awaiting and log.
export async function sendMail(
  message: MailMessage,
): Promise<{ id: string | null }> {
  const transport = getTransport();
  if (!transport) {
    throw new MailDeliveryError(
      "Mail is disabled (MAIL_PROVIDER=none or no provider configured)",
      "none",
      false,
    );
  }
  const result = await transport.send({
    ...message,
    from: config.mail.from,
    replyTo: message.replyTo ?? config.mail.replyTo,
    idempotencyKey: message.idempotencyKey ?? randomUUID(),
  });
  // the recipient address is PII; the provider id is what lets support
  // find the message in the provider's dashboard.
  logger.info(
    { provider: transport.provider, messageId: result.id },
    "Mail sent",
  );
  return result;
}
