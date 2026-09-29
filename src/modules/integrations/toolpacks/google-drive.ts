import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import logger from "@/api/lib/logger";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { fetchBounded, fetchBoundedBytes } from "@/lib/outbound";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

// Google Drive OUTBOUND toolpack: find a file (search returns each match's shareable link) or send
// it to the customer. The vault OAuth bearer (kind `google_oauth`, shared with Calendar, refreshed
// by prepare.ts) goes ONLY into the Authorization header. `folderId` is bound to the INSTANCE
// CONFIG, never a tool arg; fixed origin (SSRF-guarded anyway); https-only, no redirects, bounded
// timeout, byte-capped download. Sending needs ctx.chatwoot; without it (playground) the tool
// degrades with a message.
// TODO: validate query escaping, shared-drive flags and Google-apps export on a real account.

const DRIVE_ORIGIN = "https://www.googleapis.com/drive/v3";
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 100_000;
const MAX_FIND_RESULTS = 10;
// WhatsApp/Chatwoot practical document ceiling; a larger file is refused (link instead).
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

// The folder the search is scoped to, bound to config (optional). When set, find only matches files
// directly inside it. Path-encoded into the query at call sites; the origin stays the fixed constant.
function resolveFolderId(config: Record<string, unknown>): string | undefined {
  const v = config.folderId;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Drive query values are single-quoted; a literal quote or backslash in the user's term must be
// escaped or it breaks the query (or worse, alters it). Defense alongside the bound folder scope.
function escapeQueryValue(value: string): string {
  return value.replace(/[\\']/g, "\\$&");
}

interface DriveResponse {
  status: number;
  json: unknown;
}

async function driveFetch(
  path: string,
  init: { method: string; token: string; body?: unknown },
  ctx: ToolpackCtx,
): Promise<DriveResponse> {
  const url = `${DRIVE_ORIGIN}${path}`;
  const assertSafe = ctx.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(url);
  const doFetch = ctx.fetchImpl ?? fetch;
  // The cap is on what is READ, not a slice of what was already read: `.text()` buffers the
  // whole body before any limit applies.
  const { res, body } = await fetchBounded(
    url,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        "Content-Type": "application/json",
        "User-Agent": "agents",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
    },
    { timeoutMs: TIMEOUT_MS, cap: MAX_RESPONSE_CHARS, fetchImpl: doFetch },
  );
  let json: unknown = null;
  try {
    json = JSON.parse(body.text);
  } catch {
    // non-JSON body → leave json null; the caller surfaces a generic error
  }
  return { status: res.status, json };
}

// Binary download (alt=media or /export). Byte-capped: refuses past MAX_DOWNLOAD_BYTES via the
// Content-Length header AND the actual body length (a missing/lying header still gets caught).
async function driveDownload(
  path: string,
  token: string,
  ctx: ToolpackCtx,
): Promise<{ status: number; bytes: ArrayBuffer | null; tooLarge: boolean }> {
  const url = `${DRIVE_ORIGIN}${path}`;
  const assertSafe = ctx.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(url);
  const doFetch = ctx.fetchImpl ?? fetch;
  // Byte-capped ON THE READ, so a huge file is refused without being held in memory. The two
  // cheap refusals happen BEFORE a byte is read (`readWhen`): a declared size over the cap is
  // turned down without pulling any of it, and a non-2xx body is an error page nothing here reads.
  const { res, body } = await fetchBoundedBytes(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agents",
      },
      redirect: "error",
    },
    {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_DOWNLOAD_BYTES,
      fetchImpl: doFetch,
      readWhen: (r) =>
        r.status >= 200 &&
        r.status < 300 &&
        Number(r.headers.get("content-length") ?? "0") <= MAX_DOWNLOAD_BYTES,
    },
  );
  if (res.status < 200 || res.status >= 300)
    return { status: res.status, bytes: null, tooLarge: false };
  // A 2xx whose body was not read means the predicate refused it, and at a 2xx the only thing it
  // looks at is the declared size. `tooLarge` covers the server that understated it: the cap
  // catches that one on the way in.
  if (body === null || body.tooLarge)
    return { status: res.status, bytes: null, tooLarge: true };
  return {
    status: res.status,
    bytes: body.bytes.buffer as ArrayBuffer,
    tooLarge: false,
  };
}

async function resolveToken(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): Promise<string | null> {
  return sel.credentialRef
    ? await ctx.resolveCredential(sel.credentialRef)
    : null;
}

const NOT_CONNECTED =
  "Google Drive is not connected for this integration. Connect a Google account (Drive scope) in the integration's credential.";

const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

// Tool input schemas (single source for both the runtime tool and the UI arg specs). Risk is
// declared in DRIVE_TOOL_SPECS: reads (find/link) are low, pushing a file to the customer is medium.
const FIND_FILE_SCHEMA = z.object({
  query: z
    .string()
    .min(1)
    .describe("Text to match in the file name (case-insensitive)."),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max files to return (default 5, max ${MAX_FIND_RESULTS}).`),
});

const SEND_FILE_SCHEMA = z.object({
  fileId: z.string().min(1).describe("The Drive file id to send."),
  caption: z
    .string()
    .max(500)
    .optional()
    .describe("Optional message to send alongside the file."),
});

const DRIVE_TOOL_SPECS: ToolSpec[] = [
  { name: "drive_find_file", schema: FIND_FILE_SCHEMA },
  // The file goes to the customer as an attachment, after a download that costs real time and
  // Google quota — so a muted turn is not offered it at all.
  {
    name: "drive_send_file",
    schema: SEND_FILE_SCHEMA,
    deliversToCustomer: true,
  },
];

function buildFindFileTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const folderId = resolveFolderId(sel.config);
  return failableTool(
    async (input: { query: string; maxResults?: number }) => {
      const token = await resolveToken(sel, ctx);
      if (!token) return toolFailure(NOT_CONNECTED);
      const term = escapeQueryValue(input.query.trim());
      const clauses = [`name contains '${term}'`, "trashed = false"];
      if (folderId) clauses.push(`'${escapeQueryValue(folderId)}' in parents`);
      const params = new URLSearchParams({
        q: clauses.join(" and "),
        fields: "files(id,name,mimeType,webViewLink,webContentLink)",
        orderBy: "modifiedTime desc",
        pageSize: String(
          Math.min(Math.max(input.maxResults ?? 5, 1), MAX_FIND_RESULTS),
        ),
        spaces: "drive",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      let res: DriveResponse;
      try {
        res = await driveFetch(
          `/files?${params.toString()}`,
          { method: "GET", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "drive: find file request failed");
        return toolFailure("Failed to reach Google Drive. Try again shortly.");
      }
      if (res.status < 200 || res.status >= 300) {
        return toolFailure(`Google Drive returned HTTP ${res.status}.`);
      }
      const data = (res.json ?? {}) as Record<string, unknown>;
      const files = Array.isArray(data.files) ? data.files : [];
      return JSON.stringify(
        files.map((f) => {
          const o = (f ?? {}) as Record<string, unknown>;
          // The shareable link comes straight from the search (webViewLink, falling back to
          // webContentLink for direct-download files) — no separate "get link" round-trip needed.
          const link =
            typeof o.webViewLink === "string"
              ? o.webViewLink
              : typeof o.webContentLink === "string"
                ? o.webContentLink
                : null;
          return {
            id: typeof o.id === "string" ? o.id : null,
            name: typeof o.name === "string" ? o.name : null,
            mimeType: typeof o.mimeType === "string" ? o.mimeType : null,
            link,
          };
        }),
      );
    },
    {
      name: "drive_find_file",
      description:
        "Search Google Drive for files whose name contains the given text. Returns each match's id, name, type and shareable link — send the link to the customer, or pass the id to drive_send_file to deliver the file itself.",
      schema: FIND_FILE_SCHEMA,
    },
  );
}

function buildSendFileTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: { fileId: string; caption?: string }) => {
      const token = await resolveToken(sel, ctx);
      if (!token) return toolFailure(NOT_CONNECTED);
      if (!ctx.chatwoot) {
        return "Sending a file to the customer is not available in this context (e.g. the playground). Share the file's link (returned by drive_find_file) instead.";
      }

      // 1) Metadata: name + mimeType decide the download path (native media vs Google-apps export).
      let meta: DriveResponse;
      try {
        meta = await driveFetch(
          `/files/${encodeURIComponent(input.fileId)}?fields=name,mimeType,size&supportsAllDrives=true`,
          { method: "GET", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "drive: send file metadata request failed");
        return toolFailure("Failed to reach Google Drive. Try again shortly.");
      }
      if (meta.status < 200 || meta.status >= 300) {
        return toolFailure(`Google Drive returned HTTP ${meta.status}.`);
      }
      const m = (meta.json ?? {}) as Record<string, unknown>;
      const name = typeof m.name === "string" ? m.name : "file";
      const mimeType =
        typeof m.mimeType === "string"
          ? m.mimeType
          : "application/octet-stream";

      // Google-apps docs (Docs/Sheets/Slides) are not directly downloadable → export to PDF.
      const isGoogleApp = mimeType.startsWith(GOOGLE_APPS_PREFIX);
      const downloadPath = isGoogleApp
        ? `/files/${encodeURIComponent(input.fileId)}/export?mimeType=application/pdf`
        : `/files/${encodeURIComponent(input.fileId)}?alt=media&supportsAllDrives=true`;
      const sendName = isGoogleApp ? `${name}.pdf` : name;
      const sendMime = isGoogleApp ? "application/pdf" : mimeType;

      // 2) Download (byte-capped).
      let dl: { status: number; bytes: ArrayBuffer | null; tooLarge: boolean };
      try {
        dl = await driveDownload(downloadPath, token, ctx);
      } catch (err) {
        logger.warn({ err }, "drive: send file download failed");
        return toolFailure(
          "Failed to download the file from Google Drive. Try again shortly.",
        );
      }
      if (dl.tooLarge) {
        return "That file is too large to send here. Share the file's link (returned by drive_find_file) instead.";
      }
      if (dl.status < 200 || dl.status >= 300 || !dl.bytes) {
        return toolFailure(
          `Could not download the file from Google Drive (HTTP ${dl.status}).`,
        );
      }

      // 3) Deliver to the customer via the live conversation (bot token, multipart).
      try {
        await ctx.chatwoot.client.sendFileAttachment(
          ctx.chatwoot.conversationId,
          dl.bytes,
          sendName,
          sendMime,
          // The caption is the model's text, escaped for Chatwoot's Liquid.
          input.caption ? { caption: literalForChatwoot(input.caption) } : {},
        );
      } catch (err) {
        logger.warn({ err }, "drive: send file delivery failed");
        return toolFailure(
          "Downloaded the file but could not deliver it to the conversation.",
        );
      }
      return `Sent the file "${sendName}" to the customer.`;
    },
    {
      name: "drive_send_file",
      description:
        "Send a Google Drive file directly to the customer in this conversation (as an attachment). Provide the file id (from drive_find_file) and an optional caption. Google Docs/Sheets/Slides are exported to PDF first.",
      schema: SEND_FILE_SCHEMA,
    },
  );
}

const TOOL_BUILDERS: Record<
  string,
  (sel: IntegrationSelection, ctx: ToolpackCtx) => StructuredToolInterface
> = {
  drive_find_file: buildFindFileTool,
  drive_send_file: buildSendFileTool,
};

export const googleDriveToolpack: Toolpack = {
  catalogType: "GOOGLE_DRIVE",
  toolSpecs: DRIVE_TOOL_SPECS,
  build(sel, ctx) {
    const out: StructuredToolInterface[] = [];
    for (const name of sel.enabledTools) {
      const builder = TOOL_BUILDERS[name];
      if (builder) out.push(builder(sel, ctx));
    }
    return out;
  },
};

registerToolpack(googleDriveToolpack);
