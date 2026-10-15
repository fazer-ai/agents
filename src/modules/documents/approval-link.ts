// Where the link at the end of an approval request's private note points (docs/documents.md,
// Approval). The console page by default; an operator whose reviewers work in another app points it
// there with a URL template, or leaves the link out. The note itself is always written: it carries
// the decision, the reviewer's note and the expiry, which the person the conversation falls to needs.

import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { runScopedOn } from "@/lib/tenancy";
import { consoleUrl } from "@/modules/mcp/console-links";
import { markdownLink } from "./markdown-link";

export const APPROVAL_LINK_MODES = ["console", "custom", "none"] as const;
export type ApprovalLinkMode = (typeof APPROVAL_LINK_MODES)[number];

export const APPROVAL_LINK_ID_TOKEN = "{id}";
export const APPROVAL_LINK_TEMPLATE_MAX = 500;

export const approvalLinkSchema = z.object({
  mode: z.enum(APPROVAL_LINK_MODES),
  urlTemplate: z.string().max(APPROVAL_LINK_TEMPLATE_MAX),
});
export type ApprovalLinkSettings = z.infer<typeof approvalLinkSchema>;

export const APPROVAL_LINK_DEFAULTS: ApprovalLinkSettings = {
  mode: "console",
  urlTemplate: "",
};

// Lenient, like every other block reader: a stored block this build cannot read is the default, and a
// `custom` block whose template no longer passes the write rule falls back to the console link rather
// than writing a link nobody can follow.
export function parseApprovalLinkSettings(
  settings: unknown,
): ApprovalLinkSettings {
  const block = (settings as Record<string, unknown> | null | undefined)
    ?.approvalLink;
  const parsed = approvalLinkSchema.safeParse(block ?? {});
  if (!parsed.success) return { ...APPROVAL_LINK_DEFAULTS };
  if (
    parsed.data.mode === "custom" &&
    !isLinkTemplate(parsed.data.urlTemplate)
  ) {
    return { mode: "console", urlTemplate: parsed.data.urlTemplate };
  }
  return parsed.data;
}

// Read when a note is written, so a change applies to the next note, including one about a request
// opened before the change.
export async function readApprovalLink(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ApprovalLinkSettings> {
  const row = await runScopedOn(
    base,
    { tenantId, userId: null, role: "TENANT_ADMIN" },
    (db) =>
      db.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      }),
  );
  return parseApprovalLinkSettings(row?.settings);
}

// The prefix is checked on the text as typed, not only on the parsed URL: `new URL` repairs
// `https:/host/...`, and the note carries the text, which a browser resolves against the console.
function isLinkTemplate(template: string): boolean {
  if (!template.includes(APPROVAL_LINK_ID_TOKEN)) return false;
  if (!/^https?:\/\/[^/]/i.test(template)) return false;
  // NOTE: `new URL` drops tabs and newlines, and the note would carry them and break the link.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control chars is the point.
  if (/[\s\u0000-\u001f\u007f]/.test(template)) return false;
  // NOTE: `new URL` reads a backslash as a slash; the note carries it as typed, which no browser does.
  if (template.includes("\\")) return false;
  try {
    const url = new URL(template.replaceAll(APPROVAL_LINK_ID_TOKEN, "1"));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// What a write stores. A `custom` mode with an empty template is the operator clearing the field, so
// it is the console link again rather than a refusal; any other template is held to the rule above.
export function normalizeApprovalLink(
  input: ApprovalLinkSettings,
): ApprovalLinkSettings {
  const urlTemplate = input.urlTemplate.trim();
  if (input.mode !== "custom") return { mode: input.mode, urlTemplate };
  if (urlTemplate === "") return { mode: "console", urlTemplate: "" };
  if (!isLinkTemplate(urlTemplate)) {
    throw new AppError(
      "The approval link must be a full address starting with https:// or http://, with {id} where the request's id goes.",
      400,
      "errors.invalidApprovalLinkTemplate",
      undefined,
      "urlTemplate",
    );
  }
  return { mode: "custom", urlTemplate };
}

export function approvalPageUrl(
  settings: ApprovalLinkSettings,
  tenantId: bigint,
  requestId: bigint,
): string | null {
  if (settings.mode === "none") return null;
  if (settings.mode === "custom") {
    return settings.urlTemplate.replaceAll(
      APPROVAL_LINK_ID_TOKEN,
      String(requestId),
    );
  }
  return consoleUrl(`/document-approvals/${requestId}`, { tenantId });
}

// Every note ends on the request's page, so the person the conversation falls to opens the decision
// (and, on an expired one, asks again) from where they are working. A Markdown link: Chatwoot and the
// console both render a private note as Markdown.
export function withApprovalLink(
  text: string,
  settings: ApprovalLinkSettings,
  tenantId: bigint,
  requestId: bigint,
): string {
  const url = approvalPageUrl(settings, tenantId, requestId);
  if (url === null) return text;
  return `${text}\n\n${markdownLink("Ver aprovação", url)}`;
}
