import { describe, expect, test } from "bun:test";
import { createResendTransport } from "@/api/lib/mail/resend";
import { MailDeliveryError } from "@/api/lib/mail/types";

const message = {
  from: "App <no-reply@example.com>",
  to: "user@example.com",
  subject: "Hi",
  html: "<p>Hi</p>",
  text: "Hi",
  replyTo: "support@example.com",
  idempotencyKey: "key-1",
};

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const json = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

describe("createResendTransport", () => {
  test("posts the message to the emails endpoint", async () => {
    const { calls, impl } = fakeFetch([json(200, { id: "re_123" })]);
    const transport = createResendTransport({ apiKey: "re_key", fetch: impl });
    expect(await transport.send(message)).toEqual({ id: "re_123" });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_key");
    expect(headers["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(call?.init.body as string)).toEqual({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: message.replyTo,
    });
  });

  // the reason Resend is the first-class path: with the same key on
  // every attempt, a retry after a timeout cannot deliver twice.
  test("retries a rate limit with the same idempotency key, honouring Retry-After", async () => {
    const sleeps: number[] = [];
    const { calls, impl } = fakeFetch([
      json(
        429,
        { statusCode: 429, name: "rate_limit_exceeded", message: "slow" },
        { "retry-after": "2" },
      ),
      new Error("socket hang up"),
      json(200, { id: "re_ok" }),
    ]);
    const transport = createResendTransport({
      apiKey: "k",
      fetch: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(await transport.send(message)).toEqual({ id: "re_ok" });
    expect(calls).toHaveLength(3);
    const keys = calls.map(
      (c) => (c.init.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(new Set(keys)).toEqual(new Set(["key-1"]));
    expect(sleeps[0]).toBe(2000);
  });

  test("does not retry what retrying cannot fix", async () => {
    for (const body of [
      { statusCode: 429, name: "daily_quota_exceeded", message: "quota" },
      { statusCode: 422, name: "validation_error", message: "bad from" },
      { statusCode: 403, name: "invalid_permission", message: "domain" },
    ]) {
      const { calls, impl } = fakeFetch([json(body.statusCode, body)]);
      const transport = createResendTransport({
        apiKey: "k",
        fetch: impl,
        sleep: async () => {},
      });
      const error = await transport.send(message).catch((e) => e);
      expect(error).toBeInstanceOf(MailDeliveryError);
      expect(`${body.name}: ${error.retryable}`).toBe(`${body.name}: false`);
      expect(error.message).toContain(body.name);
      expect(calls).toHaveLength(1);
    }
  });

  test("gives up after three attempts and says it may work later", async () => {
    const { calls, impl } = fakeFetch([
      json(500, { name: "application_error", message: "boom" }),
      json(503, {}),
      json(503, { name: "service_unavailable", message: "down" }),
    ]);
    const transport = createResendTransport({
      apiKey: "k",
      fetch: impl,
      sleep: async () => {},
    });
    const error = await transport.send(message).catch((e) => e);
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(503);
  });

  test("a server error with a name the list does not know is still retried", async () => {
    const { calls, impl } = fakeFetch([
      json(500, { name: "internal_server_error", message: "boom" }),
      json(200, { id: "msg_1" }),
    ]);
    const transport = createResendTransport({
      apiKey: "k",
      fetch: impl,
      sleep: async () => {},
    });
    expect(await transport.send(message)).toEqual({ id: "msg_1" });
    expect(calls).toHaveLength(2);
  });

  test("the suite reads mail from the in-memory outbox, whatever the local env picks", async () => {
    const { default: config } = await import("@/config");
    expect(config.mail.provider).toBe("memory");
  });
});
