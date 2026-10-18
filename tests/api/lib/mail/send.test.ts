import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearMailOutbox,
  MailDeliveryError,
  mailOutbox,
  sendMail,
} from "@/api/lib/mail";
import config from "@/config";

const original = { ...config.mail };
// The outbox is process-wide, and a file that ran earlier may have left mail in it; each test
// starts from an empty one and asserts on its own recipient, never on the total.
beforeEach(() => {
  clearMailOutbox();
});
afterEach(() => {
  Object.assign(config.mail, original);
  clearMailOutbox();
});

describe("sendMail", () => {
  test("stamps the configured sender, reply-to and an idempotency key", async () => {
    config.mail.from = "App <no-reply@example.com>";
    config.mail.replyTo = "support@example.com";
    await sendMail({
      to: "a@example.com",
      subject: "s",
      html: "<p>h</p>",
      text: "h",
    });
    await sendMail({
      to: "b@example.com",
      subject: "s",
      html: "<p>h</p>",
      text: "h",
    });

    expect(mailOutbox).toHaveLength(2);
    const [first, second] = mailOutbox;
    expect(first?.from).toBe("App <no-reply@example.com>");
    expect(first?.replyTo).toBe("support@example.com");
    expect(first?.idempotencyKey).toBeString();
    // one key per message. A shared key would make Resend drop the
    // second message as a duplicate of the first.
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  test("keeps a caller's own reply-to and idempotency key", async () => {
    await sendMail({
      to: "a@example.com",
      subject: "s",
      html: "h",
      text: "h",
      replyTo: "owner@example.com",
      idempotencyKey: "fixed",
    });
    expect(mailOutbox[0]?.replyTo).toBe("owner@example.com");
    expect(mailOutbox[0]?.idempotencyKey).toBe("fixed");
  });

  test("fails loudly when mail is disabled", async () => {
    config.mail.provider = "none";
    config.mail.enabled = false;
    const error = await sendMail({
      to: "a@example.com",
      subject: "s",
      html: "h",
      text: "h",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(mailOutbox.filter((m) => m.to === "a@example.com")).toHaveLength(0);
  });
});
