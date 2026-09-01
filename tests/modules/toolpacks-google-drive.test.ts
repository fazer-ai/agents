import { describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { googleDriveToolpack } from "@/modules/integrations/toolpacks/google-drive";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

// A fetch stub whose handler decides the response per request — Drive flows mix JSON (metadata)
// with binary (download), so a single canned body would not do.
function routerFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({ url: String(url), init: i });
    return handler(String(url), i);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const noopAssert = async () => undefined;

function baseCtx(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 1n,
    base: undefined as unknown as PrismaClient,
    threadId: "1:1:1",
    resolveCredential: async () => "tok_live",
    assertSafe: noopAssert,
    ...over,
  };
}

function sel(over: Partial<IntegrationSelection> = {}): IntegrationSelection {
  return {
    instanceId: 1n,
    catalogType: "GOOGLE_DRIVE",
    config: {},
    credentialRef: "gdrive-cred",
    enabledTools: [],
    ...over,
  };
}

// Records sendFileAttachment calls; cast to the client type the toolpack ctx expects.
function fakeChatwoot(conversationId = 5) {
  const sent: Array<{
    conversationId: number;
    fileName: string;
    mime: string;
    bytes: number;
    caption?: string;
  }> = [];
  const client = {
    sendFileAttachment: async (
      conv: number,
      bytes: ArrayBuffer,
      fileName: string,
      mime: string,
      opts: { caption?: string } = {},
    ) => {
      sent.push({
        conversationId: conv,
        fileName,
        mime,
        bytes: bytes.byteLength,
        caption: opts.caption,
      });
      return null;
    },
  } as unknown as ChatwootClient;
  return { chatwoot: { client, conversationId }, sent };
}

describe("google drive toolpack — allowlist (fail-closed)", () => {
  test("empty allowlist → no tools", () => {
    expect(
      googleDriveToolpack.build(sel({ enabledTools: [] }), baseCtx()),
    ).toEqual([]);
  });
  test("only allowlisted tools are exposed", () => {
    const tools = googleDriveToolpack.build(
      sel({ enabledTools: ["drive_find_file"] }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name)).toEqual(["drive_find_file"]);
  });
  test("both tools when granted", () => {
    const tools = googleDriveToolpack.build(
      sel({
        enabledTools: ["drive_find_file", "drive_send_file"],
      }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      "drive_find_file",
      "drive_send_file",
    ]);
  });
  test("an unknown tool name yields nothing", () => {
    expect(
      googleDriveToolpack.build(sel({ enabledTools: ["bogus"] }), baseCtx()),
    ).toEqual([]);
  });
});

describe("google drive toolpack — find file", () => {
  function findTool(config: Record<string, unknown>, ctx: ToolpackCtx) {
    return googleDriveToolpack.build(
      sel({ enabledTools: ["drive_find_file"], config }),
      ctx,
    )[0];
  }

  test("builds a name-contains query, requests links, projects id/name/type/link", async () => {
    const { impl, calls } = routerFetch(() =>
      json(200, {
        files: [
          {
            id: "f1",
            name: "Contrato.pdf",
            mimeType: "application/pdf",
            webViewLink: "https://drive.google.com/file/d/f1/view",
          },
        ],
      }),
    );
    const tool = findTool({}, baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({ query: "contrato" })) as string;
    const url = new URL(calls[0]?.url ?? "");
    const q = url.searchParams.get("q") ?? "";
    expect(q).toContain("name contains 'contrato'");
    expect(q).toContain("trashed = false");
    expect(q).not.toContain("in parents");
    // The search itself asks for the shareable link (no separate get-link round-trip).
    expect(url.searchParams.get("fields")).toContain("webViewLink");
    expect(JSON.parse(out)).toEqual([
      {
        id: "f1",
        name: "Contrato.pdf",
        mimeType: "application/pdf",
        link: "https://drive.google.com/file/d/f1/view",
      },
    ]);
  });

  test("falls back to webContentLink, and link is null when neither is present", async () => {
    const { impl } = routerFetch(() =>
      json(200, {
        files: [
          {
            id: "a",
            name: "A",
            mimeType: "application/pdf",
            webContentLink: "https://drive.google.com/uc?id=a",
          },
          { id: "b", name: "B", mimeType: "application/pdf" },
        ],
      }),
    );
    const tool = findTool({}, baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({ query: "x" })) as string;
    expect(JSON.parse(out)).toEqual([
      {
        id: "a",
        name: "A",
        mimeType: "application/pdf",
        link: "https://drive.google.com/uc?id=a",
      },
      { id: "b", name: "B", mimeType: "application/pdf", link: null },
    ]);
  });

  test("the bearer token is sent only in the Authorization header, never returned", async () => {
    const { impl, calls } = routerFetch(() =>
      json(200, {
        files: [{ id: "f1", name: "Doc", mimeType: "application/pdf" }],
      }),
    );
    const tool = findTool(
      {},
      baseCtx({
        fetchImpl: impl,
        resolveCredential: async () => "SECRET_BEARER",
      }),
    );
    const out = (await tool?.invoke({ query: "x" })) as string;
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer SECRET_BEARER");
    expect(out).not.toContain("SECRET_BEARER");
  });

  test("config.folderId scopes the search to that folder", async () => {
    const { impl, calls } = routerFetch(() => json(200, { files: [] }));
    const tool = findTool({ folderId: "fld_1" }, baseCtx({ fetchImpl: impl }));
    await tool?.invoke({ query: "x" });
    const q = new URL(calls[0]?.url ?? "").searchParams.get("q") ?? "";
    expect(q).toContain("'fld_1' in parents");
  });

  test("escapes single quotes in the query term", async () => {
    const { impl, calls } = routerFetch(() => json(200, { files: [] }));
    const tool = findTool({}, baseCtx({ fetchImpl: impl }));
    await tool?.invoke({ query: "O'Brien" });
    const q = new URL(calls[0]?.url ?? "").searchParams.get("q") ?? "";
    expect(q).toContain("name contains 'O\\'Brien'");
  });

  test("not connected (no credential) → friendly message, no fetch", async () => {
    const { impl, calls } = routerFetch(() => json(200, {}));
    const tool = googleDriveToolpack.build(
      sel({ enabledTools: ["drive_find_file"], credentialRef: null }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({ query: "x" })) as string;
    expect(out).toContain("not connected");
    expect(calls).toHaveLength(0);
  });
});

describe("google drive toolpack — send file", () => {
  function sendTool(ctx: ToolpackCtx) {
    return googleDriveToolpack.build(
      sel({ enabledTools: ["drive_send_file"] }),
      ctx,
    )[0];
  }

  // ArrayBuffer body (a clean BodyInit; sidesteps the Uint8Array<ArrayBufferLike> lib mismatch).
  function binaryResponse(byteLen: number, contentLength?: number): Response {
    return new Response(new ArrayBuffer(byteLen), {
      status: 200,
      headers: { "content-length": String(contentLength ?? byteLen) },
    });
  }

  // Routes Drive: metadata (fields=...) as JSON, download (alt=media or /export) as binary bytes.
  function driveHandler(meta: unknown, byteLen: number, exportPdf = false) {
    return (url: string) => {
      if (url.includes("alt=media") || url.includes("/export")) {
        if (exportPdf && !url.includes("/export"))
          return json(404, { error: "expected export" });
        return binaryResponse(byteLen);
      }
      return json(200, meta);
    };
  }

  test("downloads a normal file and delivers it as an attachment", async () => {
    const { impl } = routerFetch(
      driveHandler(
        { name: "manual.pdf", mimeType: "application/pdf", size: "5" },
        5,
      ),
    );
    const cw = fakeChatwoot(42);
    const tool = sendTool(baseCtx({ fetchImpl: impl, chatwoot: cw.chatwoot }));
    const out = (await tool?.invoke({
      fileId: "f1",
      caption: "Segue o manual",
    })) as string;
    expect(out).toContain("manual.pdf");
    expect(cw.sent).toHaveLength(1);
    expect(cw.sent[0]).toMatchObject({
      conversationId: 42,
      fileName: "manual.pdf",
      mime: "application/pdf",
      bytes: 5,
      caption: "Segue o manual",
    });
  });

  test("a file whose declared size is over the cap is refused without reading a byte", async () => {
    // Review round 1 of #464. Capping the READ made the Content-Length check happen after 15 MB had
    // already been pulled, and on a slow link that read can spend the whole 12s budget — turning
    // "that file is too large" into a generic download failure for a file the headers already ruled
    // out. What is asserted is that the producer is never pulled.
    let pulled = 0;
    const { impl } = routerFetch((url: string) => {
      if (!url.includes("alt=media") && !url.includes("/export"))
        return json(200, {
          name: "big.bin",
          mimeType: "application/octet-stream",
        });
      return new Response(
        new ReadableStream({
          pull(c) {
            pulled += 1;
            c.enqueue(new Uint8Array(64 * 1024));
          },
        }),
        {
          status: 200,
          headers: { "content-length": String(500 * 1024 * 1024) },
        },
      );
    });
    const cw = fakeChatwoot();
    const tool = sendTool(baseCtx({ fetchImpl: impl, chatwoot: cw.chatwoot }));
    const out = (await tool?.invoke({ fileId: "f1" })) as string;
    expect(out).toContain("too large");
    // A stream fills its own queue once before anyone reads it, so ONE pull is the source's doing
    // and not ours. Reading to the 15 MB cap would take 240 of these.
    expect(pulled).toBeLessThanOrEqual(1);
    expect(cw.sent).toHaveLength(0);
  });

  test("a non-2xx download does not have its error page read", async () => {
    // Same reason, the other cheap refusal: nothing here reads a Drive error page, so pulling one
    // is a read the bound has to cover for no one's benefit.
    let pulled = 0;
    const { impl } = routerFetch((url: string) => {
      if (!url.includes("alt=media") && !url.includes("/export"))
        return json(200, {
          name: "gone.bin",
          mimeType: "application/octet-stream",
        });
      return new Response(
        new ReadableStream({
          pull(c) {
            pulled += 1;
            c.enqueue(new Uint8Array(1024));
          },
        }),
        { status: 500 },
      );
    });
    const cw = fakeChatwoot();
    const tool = sendTool(baseCtx({ fetchImpl: impl, chatwoot: cw.chatwoot }));
    const out = (await tool?.invoke({ fileId: "f1" })) as string;
    expect(out).toContain("HTTP 500");
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test("a file over the cap is refused, even when the server understates its size", async () => {
    // The refusal path had no test at all. It also had no BOUND: `arrayBuffer()` buffered the whole
    // body and `byteLength` refused it afterwards, so an honest Content-Length was the only thing
    // keeping a large file out of memory (#464). What is asserted here is the refusal; that the
    // read now stops at the cap is asserted on the reader itself, in tests/lib/outbound.test.ts,
    // where the producer can be watched.
    const OVER = 15 * 1024 * 1024 + 1;
    const { impl } = routerFetch((url: string) =>
      url.includes("alt=media") || url.includes("/export")
        ? binaryResponse(OVER, 10)
        : json(200, { name: "big.bin", mimeType: "application/octet-stream" }),
    );
    const cw = fakeChatwoot();
    const tool = sendTool(baseCtx({ fetchImpl: impl, chatwoot: cw.chatwoot }));
    const out = (await tool?.invoke({ fileId: "f1" })) as string;
    expect(out).toContain("too large");
    expect(cw.sent).toHaveLength(0);
  });

  test("Google-apps doc is exported to PDF (name + mime adjusted)", async () => {
    const { impl, calls } = routerFetch(
      driveHandler(
        { name: "Proposta", mimeType: "application/vnd.google-apps.document" },
        3,
        true,
      ),
    );
    const cw = fakeChatwoot();
    const tool = sendTool(baseCtx({ fetchImpl: impl, chatwoot: cw.chatwoot }));
    await tool?.invoke({ fileId: "doc1" });
    expect(
      calls.some((c) => c.url.includes("/export?mimeType=application/pdf")),
    ).toBe(true);
    expect(cw.sent[0]).toMatchObject({
      fileName: "Proposta.pdf",
      mime: "application/pdf",
    });
  });

  test("without a live conversation (playground) → guidance to share a link", async () => {
    const { impl, calls } = routerFetch(() => json(200, {}));
    const tool = sendTool(baseCtx({ fetchImpl: impl })); // no ctx.chatwoot
    const out = (await tool?.invoke({ fileId: "f1" })) as string;
    expect(out).toContain("not available in this context");
    expect(calls).toHaveLength(0);
  });

  test("a file above the size cap is refused (suggest a link)", async () => {
    const { impl } = routerFetch((url) => {
      if (url.includes("alt=media")) {
        return binaryResponse(1, 20 * 1024 * 1024);
      }
      return json(200, { name: "big.zip", mimeType: "application/zip" });
    });
    const cw = fakeChatwoot();
    const tool = sendTool(baseCtx({ fetchImpl: impl, chatwoot: cw.chatwoot }));
    const out = (await tool?.invoke({ fileId: "f1" })) as string;
    expect(out).toContain("too large");
    expect(cw.sent).toHaveLength(0);
  });
});

// NOTE: Integration failures must reach the flow log as failures (issue #40): invoked as a
// tool_call, network/credential failures return a ToolMessage with status "error" (same friendly
// content the model already saw).
describe("google drive toolpack — integration failures are marked (issue #40)", () => {
  test("network failure and missing credential return ToolMessage status error", async () => {
    const boom = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const network = googleDriveToolpack.build(
      sel({ enabledTools: ["drive_find_file"] }),
      baseCtx({ fetchImpl: boom }),
    )[0];
    const out = (await network?.invoke({
      type: "tool_call",
      id: "call_dr_1",
      name: "drive_find_file",
      args: { query: "contrato" },
    })) as ToolMessage;
    expect(out.status).toBe("error");
    expect(String(out.content)).toContain("Failed to reach Google Drive");

    const { impl, calls } = routerFetch(() => json(200, {}));
    const notConnected = googleDriveToolpack.build(
      sel({ enabledTools: ["drive_find_file"], credentialRef: null }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out2 = (await notConnected?.invoke({
      type: "tool_call",
      id: "call_dr_2",
      name: "drive_find_file",
      args: { query: "x" },
    })) as ToolMessage;
    expect(out2.status).toBe("error");
    expect(String(out2.content)).toContain("not connected");
    expect(calls).toHaveLength(0);
  });
});
