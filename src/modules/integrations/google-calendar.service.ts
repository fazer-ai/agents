import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ensureFreshGoogleAccessToken } from "@/modules/vault/google-oauth";
import { tryResolveVaultEntry } from "@/modules/vault/service";

// Lists the calendars a connected google_oauth credential can see, so the integration modal lets the
// operator PICK which agendas the agent may operate on (instead of typing opaque calendar ids) and
// captures their friendly names for the tool descriptions. Read-only against Google; the bearer is
// resolved by reference from the vault (never the secret to the client), tenant-scoped via RLS.

const GCAL_CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,summaryOverride,primary,accessRole)";
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 200_000;

export interface CalendarListItem {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

// Pure projection of the Google calendarList response → the slim shape the UI consumes. The user's
// own override name (summaryOverride) wins over the calendar's default summary. Exported for hermetic
// tests.
export function mapCalendarListResponse(json: unknown): CalendarListItem[] {
  const items =
    json &&
    typeof json === "object" &&
    Array.isArray((json as { items?: unknown }).items)
      ? ((json as { items: unknown[] }).items as unknown[])
      : [];
  const out: CalendarListItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string") continue;
    const summary =
      typeof c.summaryOverride === "string" && c.summaryOverride.trim()
        ? c.summaryOverride
        : typeof c.summary === "string"
          ? c.summary
          : c.id;
    out.push({
      id: c.id,
      summary,
      primary: c.primary === true,
      accessRole: typeof c.accessRole === "string" ? c.accessRole : "",
    });
  }
  return out;
}

export interface CalendarListDeps {
  // Resolves the credential entry (default: tenant-scoped vault read). Returns { kind } | null.
  resolveEntry?: (ref: string) => Promise<{ kind: string } | null>;
  // Returns a fresh google_oauth access token for the entry id (default: ensureFreshGoogleAccessToken).
  resolveToken?: (entryId: bigint) => Promise<string>;
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<unknown>;
}

// Resolves and lists the calendars for a credential ref. Throws when the ref is missing, not this
// tenant's (RLS → null), not a google_oauth entry, or malformed. The deps make it hermetically testable.
export async function listCredentialCalendars(
  ctx: TenantContext,
  credentialRef: string,
  base: PrismaClient = basePrisma,
  deps: CalendarListDeps = {},
): Promise<CalendarListItem[]> {
  const resolveEntry =
    deps.resolveEntry ??
    ((ref: string) =>
      runScopedOn(base, ctx, (db) => tryResolveVaultEntry<unknown>(db, ref)));
  const entry = await resolveEntry(credentialRef);
  if (!entry)
    throw new NotFoundError(
      "Credential not found.",
      "errors.googleCredentialNotFound",
    );
  if (entry.kind !== "google_oauth") {
    throw new AppError(
      "Credential is not a connected Google account.",
      400,
      "errors.googleCredentialNotConnected",
    );
  }
  const entryId = credentialRef.startsWith("vault:")
    ? BigInt(credentialRef.slice("vault:".length))
    : null;
  if (entryId === null) {
    throw new AppError(
      "Invalid credential reference.",
      400,
      "errors.invalidCredentialRef",
    );
  }
  const token = deps.resolveToken
    ? await deps.resolveToken(entryId)
    : await ensureFreshGoogleAccessToken(ctx, entryId, base);

  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(GCAL_CALENDAR_LIST_URL);
  const doFetch = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status: number;
  let json: unknown = null;
  try {
    const res = await doFetch(GCAL_CALENDAR_LIST_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agents",
      },
      redirect: "error",
      signal: ctrl.signal,
    });
    status = res.status;
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON → handled below
    }
  } finally {
    clearTimeout(timer);
  }
  if (status < 200 || status >= 300) {
    throw new AppError(
      `Google Calendar returned HTTP ${status}.`,
      502,
      "errors.integrationHttpError",
      { provider: "Google Calendar", status },
    );
  }
  return mapCalendarListResponse(json);
}
