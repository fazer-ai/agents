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
import { renderDocumentPdf } from "./render";
import { readRenderContext } from "./templates";
import {
  type DocumentValues,
  invalidDocumentTemplate,
  parseDocumentValues,
  parseTemplateContent,
} from "./validate";

// Issuing a document: one core, two callers (the REST route and the agent's own tool), as the API
// contract requires.
//
// Two-phase and idempotent, transplanted from the quote generator it replaces because that part of
// it was right: a burst, a retry or a resumed turn carrying the same idempotencyKey produces ONE
// document and ONE PDF, never N numbered documents in front of one customer.
//   Phase A (scoped): create the PENDING row race-safely on the [tenantId, idempotencyKey] unique
//     and re-read. An already-READY row comes back untouched.
//   Phase B (no tx): render the STORED snapshot — not the caller's argument — outside any
//     transaction (this is CPU-bound), write it to a path derived from the row id, then CAS to READY.

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
// TENANT_ADMIN is the honest answer for an id that never left the process (issue #280).
export function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Where an issued document's bytes live, under the storage root.
//
// The `documents/` segment is the load-bearing part. An install upgraded from the quotes subsystem
// keeps writing into the directory its QUOTES_STORAGE_DIR names (Coolify freezes that value, which
// is why the fallback exists at all), and that directory already holds `<tenantId>/<quoteId>.pdf`
// from before. `issued_documents` is a NEW table with a new sequence, so its ids start over and
// collide with those file names — and a collision is not a lost file, it is the wrong customer's
// document: `link` fails with EEXIST, the publish path reads that as "another renderer got here
// first", adopts the file, and marks the row READY over a stranger's quote, which is then what the
// download serves and what the agent attaches to the conversation.
//
// A segment no numeric id can produce keeps the two sets of files apart for good. Nothing has to be
// migrated: the documents feature is new, so no install has a file under this scheme yet.
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
  if (unstorable) {
    throw new AppError(unstorable, 400, "errors.invalidIdempotencyKey", {
      reason: unstorable,
    });
  }

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

  // Refused BEFORE the insert, which is what keeps a number from being burned for it: the counter is
  // bumped once the row exists, and an issued document is immutable, so a blank one is blank
  // forever. This is the exact question — every value is resolved here — and it is why the authoring
  // gate only has to answer the unconditional half.
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

  // `create` rather than `createMany({ skipDuplicates })` because the ROW is needed: what follows
  // renders and publishes against this document's own id, and createMany returns a count, not rows.
  // (The count is enough where only the fact of insertion matters — the bundle import uses exactly
  // that, because a P2002 there would abort the transaction the whole import runs in.)
  //
  // Three scoped calls, not one: a P2002 ABORTS the PostgreSQL transaction it was raised in, so
  // recovering the winner cannot happen inside the transaction that lost. Catching the conflict and
  // re-reading in the same one turns a benign race — which the idempotency key exists to make benign
  // — into "current transaction is aborted" and a 500 for the caller that merely arrived second.
  const created = await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.create({
      data: {
        tenantId,
        templateId: prepared.id,
        title: prepared.name,
        // FROZEN with the row, not joined from the template when the number is printed: the prefix
        // is part of how this document identifies itself. Read live, renaming ORC- to PROP- would
        // rewrite every number already in a customer's hands, and deleting the template (which nulls
        // the FK by design — the documents outlive it) would drop the prefix altogether.
        numberPrefix: prepared.numberPrefix,
        threadId: params.threadId ?? null,
        chatwootInstanceId: params.chatwootInstanceId ?? null,
        conversationId: params.conversationId ?? null,
        idempotencyKey: params.idempotencyKey,
        status: "PENDING",
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    }),
  ).catch((err: unknown) => {
    if (isUniqueViolation(err)) return null; // lost the race → the winner is read below
    // The template can be DELETED between the read above and this insert, and the foreign key then
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
      assignNumber(db, prepared.id, created.id),
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
  // Revocation ends the document, and the idempotency key leads straight back to it: the key is
  // derived from the VALUES, so an agent asked to send the same quote again lands on this exact row.
  // Without this the retry would hand back the stored bytes and attach a voided document to a
  // customer's reply, while the operator's own download link answered 404.
  //
  // NOT documentVerdict, which the download route uses: that one also refuses a row with no PDF, and
  // here a row with no PDF is the ordinary case — it is the one this function is about to render.
  // A 409, not a 400: nothing about the caller's arguments is wrong, and there is nothing to correct
  // that would not lead back to the same voided row.
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

  // Asked again, HERE, because the answer expires. The gate before the insert used the logo that
  // was on disk then, and this is a different moment: a PENDING row can be adopted by a retry long
  // afterwards. Everything else the render uses is frozen in the snapshot, so the letterhead is the
  // one input that can have changed — and for a template whose only content IS the letterhead,
  // changed means there is nothing left to draw.
  //
  // Refused instead of published, even though the number is already spent: the row stays PENDING,
  // so nothing was delivered and restoring the logo is all a retry needs. Publishing would freeze a
  // numbered blank page, and an issued document is immutable.
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
  // Written to a temporary name first. Two callers holding the same idempotency key can both find
  // the row PENDING and both render it, and a plain write to the final path lets the second truncate
  // a file the first already published — so a download in that window serves a half-written PDF.
  //
  // Bun.write creates parent directories, which is why the temporary lives beside the target rather
  // than in a system temp dir — and why the link below cannot cross a filesystem. The suffix keeps
  // two concurrent renders from sharing the temporary as well.
  //
  // WHAT IS COVERED: that a second publisher adopts the first one's file instead of replacing it,
  // and that no `.part` survives a successful issuance. What is NOT is the truncation itself — that
  // needs two renders of one key overlapping AND a reader landing inside the window, which no
  // single-process test reaches with any reliability (the last attempt at a race like it passed
  // three times out of three with the fix removed, and was deleted rather than kept).
  const finalPath = `${dir}/${key}`;
  const tempPath = `${finalPath}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.part`;
  await Bun.write(tempPath, buffer);

  // PUBLISHED BEFORE the row says READY, and published with `link` rather than `rename`.
  //
  // Both orders on their own leave a window, and each was tried. Renaming first lets a caller that
  // then loses the claim replace a file the winner already published — the renders share a frozen
  // snapshot, but the LOGO is read live, so the published document can visibly change after it was
  // declared final. Claiming first is worse: a reader who sees READY can arrive before the file
  // exists and get a 404, and a process killed in that window leaves a row that says READY forever
  // with nothing behind it, which nothing re-renders.
  //
  // `link` closes both instead of choosing. It creates the final name from a fully-written temporary
  // and FAILS with EEXIST if that name already exists, so the first publisher wins the file and a
  // later one adopts it rather than replacing it; and because it happens before the CAS, a row is
  // never READY without its bytes. A crash anywhere here leaves a PENDING row and at worst an
  // unreferenced temporary — both recoverable, since the next call re-renders and re-adopts.
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
  // The DOCUMENT row is claimed next, and that claim is the whole point of this function. A row
  // exists unnumbered for a moment by design — the counter is bumped after the insert, so a lost
  // idempotency race consumes no number — and in that window a second caller re-reads it, sees no
  // number, and heals it at the same time as the first. Without the lock both take a number from
  // the counter, one update is discarded, and the caller whose update lost goes on to render a
  // document with NO number and write it over the winner's PDF: the customer's link then serves a
  // quote with a blank where its identity should be.
  //
  // Scoped by RLS like every other statement in this transaction, and the id is one we inserted.
  const claimed = await db.$queryRaw<{ number: number | null }[]>`
    SELECT "number" FROM "issued_documents" WHERE "id" = ${documentId} FOR UPDATE
  `;
  if (claimed.length === 0) return null;
  const already = claimed[0]?.number ?? null;
  // Someone numbered it while we waited for the lock. Their number is the document's number.
  if (already !== null) return already;

  const rows = await db.$queryRaw<{ last_number: number }[]>`
    UPDATE "document_templates"
    SET "last_number" = "last_number" + 1
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
