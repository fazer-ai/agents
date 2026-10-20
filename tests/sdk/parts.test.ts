/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "@/sdk/markdown";
import { parseFrame, readSse } from "@/sdk/sse";
import { readClaims, stillFresh, tokenFromResponse } from "@/sdk/token";

// The widget's pure parts: the markdown it renders a reply in (never markup from the model), the SSE
// reader that follows a turn, and what it reads from the app's token.

const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;

function html(text: string): string {
  const div = document.createElement("div");
  div.appendChild(renderMarkdown(document, text));
  return div.innerHTML;
}

describe("the reply's markdown", () => {
  test("markup from the model stays text, and only http(s) links become links", () => {
    expect(html('<img src=x onerror="alert(1)"> **oi**')).toBe(
      '<p>&lt;img src=x onerror="alert(1)"&gt; <strong>oi</strong></p>',
    );
    expect(html("[a](javascript:void) [b](https://x.com/p)")).toBe(
      '<p>a <a href="https://x.com/p" target="_blank" rel="noopener noreferrer">b</a></p>',
    );
  });

  test("paragraphs, lists, code and emphasis", () => {
    expect(
      html(
        "Olá *mundo*\nlinha 2\n\n- um\n- `dois`\n\n1. a\n2. b\n\n```\n<b>x</b>\n```",
      ),
    ).toBe(
      "<p>Olá <em>mundo</em><br>linha 2</p><ul><li>um</li><li><code>dois</code></li></ul><ol><li>a</li><li>b</li></ol><pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>",
    );
  });
});

describe("the turn's stream", () => {
  test("frames split across chunks arrive whole, comments and pings included", async () => {
    const chunks = [
      'event: tool\ndata: {"phase":"st',
      'art","name":"kb"}\n\n: comment\n\nevent: ping\ndata: \n\n',
      'event: done\ndata: {"status":"done"}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    const events = [];
    for await (const ev of readSse(body)) events.push(ev);
    expect(events).toEqual([
      { event: "tool", data: '{"phase":"start","name":"kb"}' },
      { event: "ping", data: "" },
      { event: "done", data: '{"status":"done"}' },
    ]);
    expect(parseFrame(": only a comment")).toBeNull();
  });
});

describe("the app's token, as the widget reads it", () => {
  const jwt = (claims: object) =>
    `x.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.y`;

  test("expiry and owner are read, and a token near its end is not fresh", () => {
    const now = 1_000_000_000_000;
    const exp = now / 1000 + 120;
    expect(readClaims(jwt({ sub: "42", exp }))).toEqual({ sub: "42", exp });
    expect(stillFresh({ exp }, now)).toBe(true);
    expect(stillFresh({ exp: now / 1000 + 30 }, now)).toBe(false);
    expect(stillFresh({}, now)).toBe(false);
    expect(readClaims("lixo")).toEqual({});
    const utf8 = btoa(
      String.fromCharCode(...new TextEncoder().encode('{"sub":"josé"}')),
    ).replace(/=+$/, "");
    expect([
      readClaims(`x.${utf8}.y`).sub,
      readClaims(`x.${btoa('{"sub":"jos\\u00e9"}').replace(/=+$/, "")}.y`).sub,
    ]).toEqual(["josé", "josé"]);
  });

  test("the token route may answer text or { token }", async () => {
    expect(await tokenFromResponse(new BunResponse("abc.def.ghi\n"))).toBe(
      "abc.def.ghi",
    );
    expect(await tokenFromResponse(new BunResponse('{"token":"a.b.c"}'))).toBe(
      "a.b.c",
    );
    await expect(
      tokenFromResponse(new BunResponse('{"nope":1}')),
    ).rejects.toThrow();
  });
});
