import { afterEach, describe, expect, test } from "bun:test";
import { createSmtpTransport } from "@/api/lib/mail/smtp";
import { MailDeliveryError } from "@/api/lib/mail/types";

// a minimal SMTP server on a random local port, so the transport is
// exercised over the wire (EHLO, MAIL, RCPT, DATA) instead of against a
// stubbed nodemailer. `rcptReply` lets a test refuse the recipient.
function startSmtpServer(options: { rcptReply?: string } = {}) {
  const received: { from?: string; to: string[]; data: string } = {
    to: [],
    data: "",
  };
  const server = Bun.listen<{ buffer: string; inData: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", inData: false };
        socket.write("220 test ESMTP\r\n");
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        while (true) {
          if (socket.data.inData) {
            const end = socket.data.buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            received.data = socket.data.buffer.slice(0, end);
            socket.data.buffer = socket.data.buffer.slice(end + 5);
            socket.data.inData = false;
            socket.write("250 queued as TEST123\r\n");
            continue;
          }
          const lineEnd = socket.data.buffer.indexOf("\r\n");
          if (lineEnd === -1) return;
          const line = socket.data.buffer.slice(0, lineEnd);
          socket.data.buffer = socket.data.buffer.slice(lineEnd + 2);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO" || verb === "HELO") {
            socket.write("250-test\r\n250 8BITMIME\r\n");
          } else if (verb === "MAIL") {
            received.from = line;
            socket.write("250 ok\r\n");
          } else if (verb === "RCPT") {
            received.to.push(line);
            socket.write(options.rcptReply ?? "250 ok\r\n");
          } else if (verb === "DATA") {
            socket.data.inData = true;
            socket.write("354 go ahead\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else {
            socket.write("250 ok\r\n");
          }
        }
      },
    },
  });
  return { server, received };
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

const message = {
  from: "App <no-reply@example.com>",
  to: "user@example.com",
  subject: "Reset your password",
  html: "<p>Click <a href='https://a.example/x'>here</a></p>",
  text: "Click: https://a.example/x",
  replyTo: "support@example.com",
};

describe("createSmtpTransport", () => {
  test("delivers a multipart message with both parts", async () => {
    const { server, received } = startSmtpServer();
    stop = () => server.stop(true);
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
    });

    const result = await transport.send(message);
    expect(result.id).toMatch(/^<.+>$/);
    expect(received.from).toContain("<no-reply@example.com>");
    expect(received.to).toEqual(["RCPT TO:<user@example.com>"]);
    expect(received.data).toContain("Subject: Reset your password");
    expect(received.data).toContain("Reply-To: support@example.com");
    expect(received.data).toContain("multipart/alternative");
    expect(received.data).toContain("Content-Type: text/plain");
    expect(received.data).toContain("Content-Type: text/html");
  });

  // RFC 5321: a 4xx reply is a temporary refusal, a 5xx a permanent one.
  test("reports a temporary refusal as retryable and a permanent one as not", async () => {
    for (const [reply, retryable] of [
      ["450 mailbox busy\r\n", true],
      ["550 no such user\r\n", false],
    ] as const) {
      const { server } = startSmtpServer({ rcptReply: reply });
      const transport = createSmtpTransport({
        host: "127.0.0.1",
        port: server.port,
        secure: false,
      });
      const error = await transport.send(message).catch((e) => e);
      server.stop(true);
      expect(error).toBeInstanceOf(MailDeliveryError);
      expect(`${reply.trim()}: ${error.retryable}`).toBe(
        `${reply.trim()}: ${retryable}`,
      );
    }
  });

  test("an unreachable host is a retryable failure", async () => {
    const { server } = startSmtpServer();
    const port = server.port;
    server.stop(true);
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port,
      secure: false,
    });
    const error = await transport.send(message).catch((e) => e);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error.retryable).toBe(true);
  });
});
