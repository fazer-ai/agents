import logger from "@/api/lib/logger";
import type { MailTransport, OutgoingMail } from "@/api/lib/mail/types";

// the development default when no provider is configured. Logs the TEXT
// part, which is what carries the links a developer needs to click (a reset
// link, a verification link). Refused in production by config.ts, since it
// writes those links into the log.
export function createConsoleTransport(): MailTransport {
  return {
    provider: "console",
    async send(message: OutgoingMail) {
      logger.info(
        `[mail] To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`,
      );
      return { id: null };
    },
  };
}

// test-only (config.ts refuses it elsewhere). Tests read what was sent
// from `mailOutbox` instead of replacing the mail module with `mock.module`,
// which is process-global in Bun and would leak into every later test file.
export const mailOutbox: OutgoingMail[] = [];

export function clearMailOutbox() {
  mailOutbox.length = 0;
}

export function createMemoryTransport(): MailTransport {
  return {
    provider: "memory",
    async send(message: OutgoingMail) {
      mailOutbox.push(message);
      return { id: `memory-${mailOutbox.length}` };
    },
  };
}
