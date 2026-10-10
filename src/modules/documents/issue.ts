import { link, rm } from "node:fs/promises";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { DEFAULT_TIMEZONE, partsInTimezone } from "@/graph/time";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { unstorableProblem } from "@/lib/text";
import type { CompanySettings } from "@/modules/tenant-settings/service";
import {
  type DocumentBlock,
  type DocumentField,
  type DocumentStyle,
  parseDocumentStyle,
} from "./blocks";
import { documentVerdict } from "./deliverable";
import { documentDraws } from "./draws";
import { formatDate, formatDocumentNumber } from "./format";
import { highestIssuedNumber, lockNumberSequence } from "./numbering";
import { renderDocumentPdf } from "./render";
import { readRenderContext } from "./templates";
import {
  type DocumentValues,
  invalidDocumentTemplate,
  parseDocumentValues,
  parseTemplateContent,
} from "./validate";

// Issuing a document: one core, two callers (the REST route and the agent's own tool). Two-phase and
// idempotent, so a burst, retry or resumed turn with one idempotencyKey yields ONE numbered document.
// Phase A (scoped) creates the PENDING row race-safely on [tenantId, idempotencyKey]; phase B renders
// the STORED snapshot outside any transaction, writes it, then CASes to READY. See docs/documents.md.

export interface DocumentSnapshot {
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
  company: CompanySettings;
  values: DocumentValues;
  issuedAt: string;
  // The calendar day the document is DATED, resolved in the issuing agent's timezone and frozen
  // here. Slicing the UTC day off `issuedAt` is wrong for every tenant that is not on UTC: a
  // document issued at 22:00 in São Paulo is 01:00 UTC the next day, so the customer receives a
  // quote dated tomorrow. Frozen rather than recomputed so a re-render cannot drift from it.
  issuedDate?: string;
}

export interface IssueDocumentParams {
  ctx: TenantContext;
  templateId: bigint;
  idempotencyKey: string;
  values: unknown;
  threadId?: string | null;
  chatwootInstanceId?: bigint | null;
  conversationId?: bigint | null;
  // Returns the PDF bytes alongside the row. The agent's tool needs them (it attaches the file it
  // just issued); the REST route does not, and asking for them there would buy a disk read per call.
  withBytes?: boolean;
  base?: PrismaClient;
  storageDir?: string;
  now?: Date;
  // IANA zone the document's DATE is resolved in — the issuing agent's, from its business hours.
  // The REST route has no agent, so it falls back to the fleet default.
  timezone?: string;
}

export interface IssuedDocumentResult {
  id: string;
  number: string;
  title: string;
  status: string;
  fileName: string;
  bytes?: ArrayBuffer;
}

// Which day a stored document is DATED. The frozen one, never a slice of the instant:
// the first ten characters of `issuedAt` are the UTC calendar day, a day ahead of the customer's
// for every evening issuance east of UTC-0. That cut survives only as the fallback for a row
// written before the frozen day existed — that row was rendered with exactly that answer, so
// re-rendering it must not silently move its date.
export function printedDate(snapshot: {
  issuedAt: string;
  issuedDate?: string;
}): string {
  return snapshot.issuedDate ?? snapshot.issuedAt.slice(0, 10);
}

// The calendar day at an instant, in one zone, as YYYY-MM-DD.
export function calendarDay(at: Date, timezone: string): string {
  const parts = partsInTimezone(at, timezone);
  return `${parts.YYYY}-${parts.MM}-${parts.DD}`;
}

// The context for a tenant id this process read from a row, for the callers that HAVE one and no
// request context: the agent's own document tool, whose tenant came off the thread it is answering.
// `issueDocument` takes a TenantContext precisely so the id's provenance survives the call, and
// TENANT_ADMIN is the honest answer for an id that never left the process.
export function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Where an issued document's bytes live, under the storage root. The `documents/` segment is
// load-bearing: an upgraded install may share a directory with old `<tenantId>/<quoteId>.pdf`
// files, and a colliding id would publish a stranger's quote (docs/documents.md, storage).
export function storageKey(tenantId: bigint, documentId: bigint): string {
  return `${tenantId}/documents/${documentId}.pdf`;
}

export function documentFileName(title: string, number: string | null): string {
  // ASCII-only, because the file name travels through a multipart upload to Chatwoot and then into
  // a Content-Disposition header on the way to the customer's phone. Derived from the template's own
  // title, never from a value the model wrote.
  const base = `${title} ${number ?? ""}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "documento"}.pdf`;
}

// The key an approval issues under. Approving reuses whatever row already holds it, so a caller of
// `issueDocument` may not write a new one: a document planted under it would be adopted by the
// approval as if it were the snapshot the reviewer saw. A row that already holds such a key still
// answers its retry, since older builds accepted the prefix.
export const APPROVAL_KEY_PREFIX = "approval:";

function reservedKeyProblem(key: string): string | null {
  return key.startsWith(APPROVAL_KEY_PREFIX)
    ? `idempotencyKey: the prefix "${APPROVAL_KEY_PREFIX}" is reserved for approved documents.`
    : null;
}

function invalidKey(reason: string): AppError {
  return new AppError(reason, 400, "errors.invalidIdempotencyKey", { reason });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export async function issueDocument(
  params: IssueDocumentParams,
): Promise<IssuedDocumentResult> {
  const base = params.base ?? basePrisma;
  const dir = params.storageDir ?? config.documentsStorageDir;
  const { ctx } = params;
  const tenantId = ctx.tenantId as bigint;
  const now = params.now ?? new Date();

  // Checked before the key is BOUND, not after: the very first thing done with it is a comparison
  // against a `text` column, and Postgres refuses a NUL there. So a key the REST schema accepts on
  // its length alone produced a 500 from the lookup — before the template, before the render, before
  // anything a caller could be told about. In the core rather than in the controller, because the
  // agent tool and MCP reach this by their own roads.
  const unstorable = unstorableProblem(params.idempotencyKey, "idempotencyKey");
  if (unstorable) throw invalidKey(unstorable);

  // The idempotency check comes FIRST, before the template is even read. Validating the caller's
  // values against the CURRENT template up front would make a retry fail the moment the template
  // changed — which is exactly backwards: the whole point of the key is that the document already
  // exists and its content was frozen when it was issued. It is also the cheaper order, since the
  // common retry never touches the template at all.
  const existing = await runScopedOn(base, ctx, (db) =>
    loadByKey(db, tenantId, params.idempotencyKey),
  );
  if (existing) {
    return finish(existing, {
      base,
      ctx,
      dir,
      tenantId,
      withBytes: params.withBytes,
    });
  }
  const reserved = reservedKeyProblem(params.idempotencyKey);
  if (reserved) throw invalidKey(reserved);

  const frozen = await freezeDocumentSnapshot({
    ctx,
    base,
    templateId: params.templateId,
    values: params.values,
    now,
    timezone: params.timezone,
  });
  return issueFrozenDocument({
    ctx,
    base,
    storageDir: dir,
    templateId: frozen.template.id,
    title: frozen.template.name,
    numberPrefix: frozen.template.numberPrefix,
    snapshot: frozen.snapshot,
    idempotencyKey: params.idempotencyKey,
    threadId: params.threadId,
    chatwootInstanceId: params.chatwootInstanceId,
    conversationId: params.conversationId,
    withBytes: params.withBytes,
  });
}

export interface FrozenDocument {
  template: {
    id: bigint;
    name: string;
    numberPrefix: string | null;
    requiresApproval: boolean;
    approvalTtlHours: number;
  };
  snapshot: DocumentSnapshot;
}

// Everything a document is, short of its number: the template read, the values validated, the
// snapshot frozen with its date. The agent's tool stores this on an approval request when the
// template asks for one, so the reviewer previews exactly what approval issues.
export async function freezeDocumentSnapshot(params: {
  ctx: TenantContext;
  base?: PrismaClient;
  templateId: bigint;
  values: unknown;
  now: Date;
  timezone?: string;
}): Promise<FrozenDocument> {
  const base = params.base ?? basePrisma;
  const { ctx, now } = params;
  const prepared = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate.findUnique({
      where: { id: params.templateId },
      select: {
        id: true,
        name: true,
        blocks: true,
        fields: true,
        style: true,
        numberPrefix: true,
        enabled: true,
        requiresApproval: true,
        approvalTtlHours: true,
      },
    }),
  );
  if (!prepared) {
    throw new NotFoundError(
      "document template not found",
      "errors.documentTemplateNotFound",
    );
  }
  if (!prepared.enabled) {
    throw new AppError(
      "this document template is disabled",
      400,
      "errors.documentTemplateDisabled",
    );
  }
  const content = parseTemplateContent(
    prepared.blocks,
    prepared.fields,
    prepared.style,
  );
  if (!content.ok) {
    throw invalidDocumentTemplate(content.reason);
  }
  const parsedValues = parseDocumentValues(
    content.content.fields,
    params.values,
  );
  if (!parsedValues.ok) {
    throw new AppError(
      parsedValues.reason,
      400,
      "errors.invalidDocumentValues",
      { reason: parsedValues.reason },
    );
  }
  const { company, logo } = await readRenderContext(ctx, base);
  const snapshot: DocumentSnapshot = {
    blocks: content.content.blocks,
    fields: content.content.fields,
    style: parseDocumentStyle(prepared.style),
    company,
    values: parsedValues.values,
    issuedAt: now.toISOString(),
    issuedDate: calendarDay(now, params.timezone ?? DEFAULT_TIMEZONE),
  };

  // Refused BEFORE any row exists, which is what keeps a number from being burned for it: an issued
  // document is immutable, so a blank one is blank forever. This is the exact question — every value
  // is resolved here — and it is why the authoring gate only has to answer the unconditional half.
  //
  // The number is not assigned yet, so the meta below carries a placeholder for it. It has to be
  // NON-EMPTY: `{{doc_number}}` always resolves to something at render, and a block that is only
  // that token draws.
  if (
    !documentDraws({
      blocks: snapshot.blocks,
      fields: snapshot.fields,
      style: snapshot.style,
      values: snapshot.values,
      company,
      hasLogo: logo !== null,
      meta: {
        number: formatDocumentNumber(1, prepared.numberPrefix),
        date: formatDate(printedDate(snapshot), snapshot.style.locale),
        title: prepared.name,
      },
    })
  ) {
    throw new AppError(
      "this document would be blank: with the values given, no block prints anything.",
      400,
      "errors.documentWouldBeBlank",
    );
  }
  return {
    template: {
      id: prepared.id,
      name: prepared.name,
      numberPrefix: prepared.numberPrefix,
      requiresApproval: prepared.requiresApproval,
      approvalTtlHours: prepared.approvalTtlHours,
    },
    snapshot,
  };
}

// Issues a snapshot that is already frozen: inserts the PENDING row, numbers it, renders. The key
// decides reuse, so a retried call with the same key returns the row the first one made.
export async function issueFrozenDocument(params: {
  ctx: TenantContext;
  base?: PrismaClient;
  storageDir?: string;
  // Null once the template is deleted: a key that already names a row still answers with it, and
  // only a new row needs the counter the template holds.
  templateId: bigint | null;
  title: string;
  numberPrefix: string | null;
  snapshot: DocumentSnapshot;
  idempotencyKey: string;
  threadId?: string | null;
  chatwootInstanceId?: bigint | null;
  conversationId?: bigint | null;
  withBytes?: boolean;
  // Run in the insert's transaction, before the row is written: a caller that answers this key from
  // another table re-asks that table here, under its own lock.
  guard?: (db: ScopedDb) => Promise<void>;
}): Promise<IssuedDocumentResult> {
  const base = params.base ?? basePrisma;
  const dir = params.storageDir ?? config.documentsStorageDir;
  const { ctx } = params;
  const tenantId = ctx.tenantId as bigint;
  const existing = await runScopedOn(base, ctx, (db) =>
    loadByKey(db, tenantId, params.idempotencyKey),
  );
  if (existing) {
    return finish(existing, {
      base,
      ctx,
      dir,
      tenantId,
      withBytes: params.withBytes,
    });
  }

  const templateId = params.templateId;
  if (templateId === null) {
    throw new AppError(
      "this document could not be numbered",
      409,
      "errors.documentNotNumbered",
    );
  }
  // `create`, not `createMany({ skipDuplicates })`, because the ROW is needed. Three scoped
  // calls, not one: a P2002 ABORTS the PostgreSQL transaction it was raised in, so the winner must
  // be re-read outside the transaction that lost, or the second caller gets a 500.
  const created = await runScopedOn(base, ctx, async (db) => {
    if (params.guard) await params.guard(db);
    return db.issuedDocument.create({
      data: {
        tenantId,
        templateId,
        title: params.title,
        // FROZEN with the row, not joined from the template when the number is printed: the prefix
        // is part of how this document identifies itself. Read live, renaming ORC- to PROP- would
        // rewrite every number already in a customer's hands, and deleting the template (which nulls
        // the FK by design — the documents outlive it) would drop the prefix altogether.
        numberPrefix: params.numberPrefix,
        threadId: params.threadId ?? null,
        chatwootInstanceId: params.chatwootInstanceId ?? null,
        conversationId: params.conversationId ?? null,
        idempotencyKey: params.idempotencyKey,
        status: "PENDING",
        snapshot: params.snapshot as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  }).catch((err: unknown) => {
    if (isUniqueViolation(err)) return null; // lost the race → the winner is read below
    // The template can be DELETED between the read and this insert, and the foreign key then
    // refuses the row (P2003). That is the same event as "no such template", which the read itself
    // would have reported a moment earlier — so it gets the same terminal answer instead of a 500
    // for the REST caller and an integration-failure alert for an agent turn.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      throw new NotFoundError(
        "document template not found",
        "errors.documentTemplateNotFound",
      );
    }
    throw err;
  });
  if (created) {
    // Bumped AFTER the insert, so a losing race on the idempotency key does not consume a number.
    // A crash between the two leaves the row unnumbered, which the load below heals — monotonic,
    // with a gap only where a process actually died.
    await runScopedOn(base, ctx, (db) =>
      assignNumber(db, templateId, created.id),
    );
  }
  const row = await runScopedOn(base, ctx, (db) =>
    loadByKey(db, tenantId, params.idempotencyKey),
  );
  if (!row) throw new AppError("failed to persist the document", 500);
  return finish(row, { base, ctx, dir, tenantId, withBytes: params.withBytes });
}

interface LoadedDocument {
  id: bigint;
  number: number | null;
  title: string;
  status: string;
  snapshot: unknown;
  pdfStorageKey: string | null;
  templateId: bigint | null;
  numberPrefix: string | null;
  revoked: boolean;
}

async function loadByKey(
  db: ScopedDb,
  tenantId: bigint,
  idempotencyKey: string,
): Promise<LoadedDocument | null> {
  const doc = await db.issuedDocument.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      snapshot: true,
      pdfStorageKey: true,
      templateId: true,
      numberPrefix: true,
      revoked: true,
    },
  });
  if (!doc) return null;
  return {
    id: doc.id,
    number: doc.number,
    title: doc.title,
    status: doc.status,
    snapshot: doc.snapshot,
    pdfStorageKey: doc.pdfStorageKey,
    templateId: doc.templateId,
    numberPrefix: doc.numberPrefix,
    revoked: doc.revoked,
  };
}

// Everything after the row exists: heal a missing number, render if it is still PENDING, and answer.
// Shared by both entry paths so a retry and a fresh issuance cannot drift apart.
async function finish(
  loaded: LoadedDocument,
  deps: {
    base: PrismaClient;
    ctx: TenantContext;
    dir: string;
    tenantId: bigint;
    withBytes?: boolean;
  },
): Promise<IssuedDocumentResult> {
  const { base, ctx, dir, tenantId } = deps;
  // NOTE: The key is derived from the VALUES, so re-sending the same quote lands on a revoked row,
  // which must not be handed back. NOT documentVerdict: a row with no PDF is the ordinary case here.
  // A 409, since no correction to the arguments leads anywhere but this voided row.
  if (loaded.revoked) {
    throw new AppError(
      "this document was revoked",
      409,
      "errors.documentRevoked",
    );
  }
  let row = loaded;
  if (row.number === null && row.templateId) {
    const templateId = row.templateId;
    const healed = await runScopedOn(base, ctx, (db) =>
      assignNumber(db, templateId, row.id),
    );
    if (healed !== null) row = { ...row, number: healed };
  }
  if (row.number === null) {
    // The counter lives on the TEMPLATE, and the template can be deleted between the insert and the
    // numbering — the FK nulls templateId by design, because documents outlive the template they
    // came from. Rendering anyway would put a document with a blank where its number belongs in
    // front of a customer, and the number is how the document identifies itself. Refused instead;
    // the row stays PENDING, so nothing was half-delivered and nothing claims to be a document.
    throw new AppError(
      "this document could not be numbered",
      409,
      "errors.documentNotNumbered",
    );
  }
  const numberLabel = formatDocumentNumber(row.number, row.numberPrefix);
  const fileName = documentFileName(row.title, numberLabel);

  if (row.status === "READY" && row.pdfStorageKey) {
    return {
      id: String(row.id),
      number: numberLabel,
      title: row.title,
      status: row.status,
      fileName,
      ...(deps.withBytes
        ? { bytes: await readStoredBytes(dir, row.pdfStorageKey) }
        : {}),
    };
  }

  // Render the STORED snapshot, which is what makes a retry produce the same document even if the
  // template was edited in between.
  const stored = row.snapshot as DocumentSnapshot;
  const style = parseDocumentStyle(stored.style);
  const { logo } = await readRenderContext(ctx, base);
  const meta = {
    number: numberLabel,
    date: formatDate(printedDate(stored), style.locale),
    title: row.title,
  };

  // NOTE: Asked again HERE: a retry can adopt a PENDING row long afterwards, and the live logo is the
  // one render input outside the snapshot. Refused rather than published even with the number spent:
  // the row stays PENDING, and publishing would freeze a numbered blank page.
  if (
    !documentDraws({
      blocks: stored.blocks,
      fields: stored.fields,
      style,
      values: stored.values,
      company: stored.company,
      hasLogo: logo !== null,
      meta,
    })
  ) {
    throw new AppError(
      "this document would be blank: with the letterhead now missing, no block prints anything.",
      409,
      "errors.documentWouldBeBlankNoLetterhead",
    );
  }

  const buffer = await renderDocumentPdf({
    blocks: stored.blocks,
    fields: stored.fields,
    style,
    values: stored.values,
    company: stored.company,
    // NOTE: the logo is read live rather than frozen into the snapshot — bytes do not belong in a
    // JSON column. It only matters on a retry that re-renders, and a letterhead swapped in that
    // window is the operator's own change taking effect.
    logo,
    meta,
  });
  const key = storageKey(tenantId, row.id);
  // Written to a unique temporary name beside the target first (so the link below never
  // crosses a filesystem): two renders of one key must not truncate a file already published. Tests
  // cover adoption and `.part` cleanup, not the truncation window itself.
  const finalPath = `${dir}/${key}`;
  const tempPath = `${finalPath}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.part`;
  await Bun.write(tempPath, buffer);

  // NOTE: PUBLISHED BEFORE the row says READY, with `link` rather than `rename`: link FAILS with
  // EEXIST, so the first publisher wins the file and a later one adopts it (the live logo could
  // differ), and a row is never READY without its bytes. A crash leaves a recoverable PENDING row
  // (docs/documents.md, Issuing).
  try {
    await link(tempPath, finalPath);
  } catch (e) {
    // EEXIST: someone published this document first. Theirs stands — same snapshot, and the one on
    // disk is the one every download will serve.
    if ((e as { code?: string }).code !== "EEXIST") {
      await rm(tempPath, { force: true });
      throw e;
    }
  }
  await rm(tempPath, { force: true });

  // `revoked: false` in the claim, not only PENDING: an operator can revoke while this render is
  // running, and without it the row would flip to READY and hand its bytes back for delivery —
  // revocation losing a race it should always win.
  const finished = await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.updateMany({
      where: { id: row.id, status: "PENDING", revoked: false },
      data: { status: "READY", pdfStorageKey: key },
    }),
  );
  if (finished.count !== 1) {
    // Lost the claim. The file on disk is whoever published first (this call adopted it if it was
    // already there), and the bytes returned have to be THAT file, not this render's: the logo is
    // read live, so the two can differ, and `withBytes: true` would attach one PDF to a customer's
    // reply while the download link served another.
    const now = await runScopedOn(base, ctx, (db) =>
      db.issuedDocument.findUnique({
        where: { id: row.id },
        select: { revoked: true, status: true, pdfStorageKey: true },
      }),
    );
    if (now?.revoked) {
      throw new AppError(
        "this document was revoked",
        409,
        "errors.documentRevoked",
      );
    }
    if (now?.status !== "READY" || !now.pdfStorageKey) {
      // Neither published: the winner's rename failed and rolled its row back. Refusing is the
      // honest answer — reporting READY over bytes nobody stored would put a document in front of a
      // customer that the download link cannot produce.
      throw new AppError(
        "this document could not be stored",
        409,
        "errors.documentNotStored",
      );
    }
    return {
      id: String(row.id),
      number: numberLabel,
      title: row.title,
      status: "READY",
      fileName,
      ...(deps.withBytes
        ? { bytes: await readStoredBytes(dir, now.pdfStorageKey) }
        : {}),
    };
  }
  return {
    id: String(row.id),
    number: numberLabel,
    title: row.title,
    status: "READY",
    fileName,
    // Read back from disk, never handed out from the local render. This call may have ADOPTED
    // another publisher's file (EEXIST above) and still won the claim, and the logo is read live —
    // so returning `buffer` could attach one PDF to the customer's reply while the download link
    // served a different one. Issuing and sending are one act; they cannot disagree about which
    // document it was.
    ...(deps.withBytes ? { bytes: await readStoredBytes(dir, key) } : {}),
  };
}

// UPDATE … RETURNING on the template row: the row lock makes the read-modify-write atomic, so two
// concurrent issuances of the same template never take the same number. Guarded on the document
// still being unnumbered so a second healer cannot overwrite the first's value.
async function assignNumber(
  db: {
    $queryRaw: PrismaClient["$queryRaw"];
    $executeRaw: PrismaClient["$executeRaw"];
    issuedDocument: PrismaClient["issuedDocument"];
  },
  templateId: bigint,
  documentId: bigint,
): Promise<number | null> {
  // TEMPLATE first, then the document. Both locks are needed and the ORDER is the load-bearing part:
  // deleting a template locks the template row and then, through the FK's ON DELETE SET NULL, the
  // issued rows that point at it. A numbering that took the document lock first and then waited on
  // the template would close a cycle, and PostgreSQL would break it by killing one side — either a
  // customer's issuance or the operator's delete. Same order everywhere, no cycle.
  //
  // The counter UPDATE below would take this same row lock anyway; taking it up front is what makes
  // the order explicit instead of incidental.
  await db.$queryRaw`
    SELECT 1 FROM "document_templates" WHERE "id" = ${templateId} FOR UPDATE
  `;
  // The DOCUMENT row is claimed first (docs/documents.md, Issuing): a row is unnumbered for a
  // moment by design, and two callers healing it at once would render one PDF with no number.
  // Scoped by RLS like every other statement in this transaction, and the id is one we inserted.
  const claimed = await db.$queryRaw<
    { number: number | null; tenant_id: bigint; number_prefix: string | null }[]
  >`
    SELECT "number", "tenant_id", "number_prefix" FROM "issued_documents" WHERE "id" = ${documentId} FOR UPDATE
  `;
  if (claimed.length === 0) return null;
  const doc = claimed[0];
  if (!doc) return null;
  // Someone numbered it while we waited for the lock. Their number is the document's number.
  if (doc.number !== null) return doc.number;

  // The sequence is the tenant's prefix, as this document prints it, not the template's counter alone
  // (numbering.ts): another template on the same prefix, or a prefix this template moved to, may have
  // issued past the counter. Locked after the template and the document, the order every path keeps.
  await lockNumberSequence(db, doc.tenant_id, doc.number_prefix);
  const highest = await highestIssuedNumber(
    db,
    doc.tenant_id,
    doc.number_prefix,
  );
  const rows = await db.$queryRaw<{ last_number: number }[]>`
    UPDATE "document_templates"
    SET "last_number" = GREATEST("last_number", ${highest}) + 1
    WHERE "id" = ${templateId}
    RETURNING "last_number"
  `;
  const next = rows[0]?.last_number;
  if (next === undefined) return null;
  await db.issuedDocument.update({
    where: { id: documentId },
    data: { number: next },
  });
  return next;
}

async function readStoredBytes(dir: string, key: string): Promise<ArrayBuffer> {
  const file = Bun.file(`${dir}/${key}`);
  if (!(await file.exists())) {
    throw new NotFoundError("document not found", "errors.documentNotFound");
  }
  return file.arrayBuffer();
}

// ── reading back ──

export interface DocumentPdf {
  bytes: ArrayBuffer;
  fileName: string;
}

// Authenticated, tenant-scoped read of an issued PDF. The scoped read is the boundary: the
// filesystem has no RLS, so the row — and with it the storage key — is only resolvable for the
// owning tenant.
export async function getIssuedDocumentPdf(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
  storageDir?: string,
): Promise<DocumentPdf> {
  const dir = storageDir ?? config.documentsStorageDir;
  const row = await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.findUnique({
      where: { id },
      select: {
        title: true,
        number: true,
        pdfStorageKey: true,
        revoked: true,
        numberPrefix: true,
      },
    }),
  );
  if (!row)
    throw new NotFoundError("document not found", "errors.documentNotFound");
  const verdict = documentVerdict(row);
  // NOTE: 404 for every refusal, revoked included. Which of the reasons applies is information about
  // a document the caller may not be entitled to know exists.
  if (!verdict.ok) {
    throw new NotFoundError("document not found", "errors.documentNotFound");
  }
  const file = Bun.file(`${dir}/${verdict.pdfStorageKey}`);
  if (!(await file.exists())) {
    throw new NotFoundError("document not found", "errors.documentNotFound");
  }
  return {
    bytes: await file.arrayBuffer(),
    fileName: documentFileName(
      row.title,
      formatDocumentNumber(row.number, row.numberPrefix),
    ),
  };
}

export interface IssuedDocumentListItem {
  id: string;
  title: string;
  number: string;
  templateId: string | null;
  status: string;
  threadId: string | null;
  conversationId: string | null;
  revoked: boolean;
  createdAt: string;
}

export async function listIssuedDocuments(
  ctx: TenantContext,
  opts: { limit?: number; templateId?: bigint; threadId?: string } = {},
  base: PrismaClient = basePrisma,
): Promise<IssuedDocumentListItem[]> {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.findMany({
      // `!== undefined`, not truthiness: a caller filtering by template 0 or by the empty thread key
      // would otherwise have its filter dropped and receive the tenant's whole recent list — the
      // widest possible answer to the narrowest possible question.
      where: {
        ...(opts.templateId !== undefined
          ? { templateId: opts.templateId }
          : {}),
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
      },
      orderBy: { id: "desc" },
      take,
      select: {
        id: true,
        title: true,
        number: true,
        templateId: true,
        status: true,
        threadId: true,
        conversationId: true,
        revoked: true,
        createdAt: true,
        numberPrefix: true,
      },
    }),
  );
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    number: formatDocumentNumber(r.number, r.numberPrefix),
    templateId: r.templateId ? String(r.templateId) : null,
    status: r.status,
    threadId: r.threadId,
    conversationId: r.conversationId ? String(r.conversationId) : null,
    revoked: r.revoked,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function revokeIssuedDocument(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const res = await db.issuedDocument.updateMany({
      where: { id },
      data: { revoked: true },
    });
    if (res.count === 0) {
      throw new NotFoundError("document not found", "errors.documentNotFound");
    }
  });
}
