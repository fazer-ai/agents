import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  type CompanySettings,
  setCompanyLogoKey,
  withCompanyLock,
} from "@/modules/tenant-settings/service";

// The tenant's letterhead logo: bytes on disk, file name in the settings block. Same split as
// branding, and the same write order (bytes first, row second) so the stored name never points at a
// file that is not there.
//
// The allowlist is NARROWER than branding's, and deliberately so. Branding assets are decoded by a
// browser; this one is decoded by @react-pdf/renderer, which handles fewer formats — a WebP simply
// does not draw, and an SVG is fed to an XML parser inside the renderer, which is a tenant upload
// reaching a parser on the server for no benefit a raster logo does not already give.
export const LOGO_EXT_BY_TYPE: Record<string, "png" | "jpg"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
export const LOGO_MAX_BYTES = 524_288; // 512 KB

// DERIVED from the map above, for the same reason the branding upload derives its own: the refusal
// names the formats it accepts, and the two surfaces do not accept the same ones.
export const LOGO_ALLOWED_FORMATS = [
  ...new Set(Object.values(LOGO_EXT_BY_TYPE)),
]
  .map((e) => e.toUpperCase())
  .join(", ");

// The BYTES decide the format, not the label on them. `file.type` is whatever the caller put in the
// multipart part (and Bun derives it from the file NAME's extension, which a REST caller controls
// outright), so a JPEG announced as image/png would be stored under a .png key and handed to
// @react-pdf/renderer as a PNG — which then fails every preview and every issuance of a template
// showing the logo, until someone thinks to remove it. Two signatures, matching the allowlist above.
const LOGO_SIGNATURES: Record<"png" | "jpg", number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
};

// The END of the file as well as its start. A signature check alone accepts a TRUNCATED upload —
// the first bytes are genuine, the rest never arrived — and the renderer then fails on every preview
// and every issuance of a template showing the logo, until somebody thinks to remove it. Both
// formats end in a fixed marker, so the cheap test for "the whole file is here" is that the marker
// is.
//
// This is a structural check, not a decode: it catches a file that was cut short, which is the
// failure that actually happens on an upload. A file that is complete and still undecodable
// (corrupt pixel data) reaches the renderer, and the render is where it is caught.
const LOGO_TERMINATORS: Record<"png" | "jpg", number[]> = {
  png: [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], // IEND + its CRC
  jpg: [0xff, 0xd9], // EOI
};

// A LOGO, not a poster. The byte cap does not bound this: PNG and JPEG both compress flat colour
// enormously, so a 40 KB file can declare 20000×20000 — and @react-pdf/renderer decodes server-side,
// allocating width × height × 4 bytes, which is 1.6 GB for that one. Every tenant shares the process.
//
// Four megapixels is roughly 2000×2000, which is far beyond what a letterhead needs (it prints
// around 150pt wide) and still bounded at ~16 MB decoded.
export const LOGO_MAX_PIXELS = 4_000_000;
// The same budget as a square side, so the refusal can say it in a shape anyone can picture. Derived
// rather than written: a hand-typed "about 2000x2000" stops being true the day the budget moves.
export const LOGO_MAX_SIDE = Math.round(Math.sqrt(LOGO_MAX_PIXELS));

// UNSIGNED, which is the whole reason this is a function. PNG writes its dimensions as uint32 and
// JavaScript's bitwise operators work on SIGNED 32-bit ints, so a value with the high bit set comes
// back negative — and a width and a height that are both negative multiply to a small POSITIVE
// number. 0xffffffff by 0xffffffff measures as 1 pixel, which walks straight through the budget
// below and hands the decoder a file declaring four billion pixels a side.
function beUint32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

// Declared dimensions, read from the header rather than by decoding. PNG puts them in the IHDR
// chunk, which the format requires to come first: 8 bytes of signature, 4 of length, 4 of type, then
// width and height. JPEG carries them in whichever SOFn frame header comes first, so the marker
// segments are walked until one turns up.
export function logoPixels(
  bytes: Uint8Array,
  ext: "png" | "jpg",
): number | null {
  if (ext === "png") {
    if (bytes.length < 24) return null;
    return beUint32(bytes, 16) * beUint32(bytes, 20);
  }
  let at = 2; // past SOI
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // FILL BYTES: any marker may be preceded by any number of 0xFF (ITU T.81, B.1.1.2). Reading one
    // as the marker turns the two bytes after it into a segment length and steps the walk off the
    // file — the image then measures as unmeasurable, which is refused, so a standards-valid logo
    // comes back to the operator as "too many pixels".
    if (marker === 0xff) {
      at++;
      continue;
    }
    // SOF0..SOF15 carry the frame header; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    // NOTE: no length guard on either read below. A byte past the end reads as `undefined ?? 0`, so
    // a truncated header measures 0 pixels and is refused by the `<= 0` check at the call site —
    // both explicit guards were written here and removed after surviving mutation against the whole
    // table, which is the definition of a clause that decides nothing.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0);
      const width = ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0);
      return width * height;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

export function logoBytesLookLike(
  bytes: Uint8Array,
  ext: "png" | "jpg",
): boolean {
  // No length guard on the signature: `every` walks the SIGNATURE, so a file shorter than it
  // compares a byte against `undefined` and fails. Measured — the guard survived removal against the
  // whole table, which is the definition of a clause that decides nothing.
  if (!LOGO_SIGNATURES[ext].every((byte, i) => bytes[i] === byte)) return false;
  const end = LOGO_TERMINATORS[ext];
  const at = bytes.length - end.length;
  // `at > 0` and not `>= 0`: a file that is ONLY its terminator has no image in it.
  return at > 0 && end.every((byte, i) => bytes[at + i] === byte);
}

export const LOGO_CONTENT_TYPE: Record<"png" | "jpg", string> = {
  png: "image/png",
  jpg: "image/jpeg",
};

// Derived from a numeric id and an extension out of the allowlist above — never from anything a
// caller wrote, so no input reaches the path.
function logoPath(key: string): string {
  return `${config.documentsStorageDir}/company/${key}`;
}

// A NAME OF ITS OWN for every upload. The tenant prefix is there to read a directory listing by
// eye; the random half is the part that matters, and it is what makes a replacement a NEW file
// instead of a write over the one every render is currently reading.
export function logoKeyFor(tenantId: bigint, ext: "png" | "jpg"): string {
  const token = randomUUID().replaceAll("-", "").slice(0, 16);
  return `${tenantId}-logo-${token}.${ext}`;
}

export function logoExtOf(key: string): "png" | "jpg" | null {
  if (key.endsWith(".png")) return "png";
  if (key.endsWith(".jpg")) return "jpg";
  return null;
}

export interface UploadedFile {
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export async function setCompanyLogo(
  ctx: TenantContext,
  file: UploadedFile,
  base: PrismaClient = basePrisma,
): Promise<CompanySettings> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const ext = LOGO_EXT_BY_TYPE[file.type];
  if (!ext) {
    throw new AppError(
      `the logo must be one of: ${LOGO_ALLOWED_FORMATS}`,
      400,
      "errors.unsupportedImageType",
      { allowed: LOGO_ALLOWED_FORMATS },
    );
  }
  if (file.size > LOGO_MAX_BYTES) {
    throw new AppError("image too large", 400, "errors.imageTooLarge");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!logoBytesLookLike(bytes, ext)) {
    throw new AppError(
      `the logo must be one of: ${LOGO_ALLOWED_FORMATS}`,
      400,
      "errors.unsupportedImageType",
      { allowed: LOGO_ALLOWED_FORMATS },
    );
  }
  // Dimensions decide, not bytes. A file well under the size cap can declare enough pixels to
  // exhaust the process when the renderer decodes it, and the renderer runs on every preview and
  // every issuance of a template that shows the logo — for every tenant on the instance.
  //
  // TWO REFUSALS, not one: an image we cannot measure is refused for the same reason (unbounded is
  // unbounded), and it is a different thing to be told. The file passed the signature and the
  // terminator, so what is wrong is the header between them — re-exporting fixes it, and shrinking
  // the image does not. One sentence covering both said "at most 4000000 pixels" about a file whose
  // pixel count nobody could read (issue #292 review).
  const pixels = logoPixels(bytes, ext);
  if (pixels === null || pixels <= 0) {
    throw new AppError(
      "the logo dimensions could not be read",
      400,
      "errors.imageDimensionsUnreadable",
    );
  }
  if (pixels > LOGO_MAX_PIXELS) {
    throw new AppError(
      `the logo must be at most ${LOGO_MAX_PIXELS} pixels (about ${LOGO_MAX_SIDE}×${LOGO_MAX_SIDE})`,
      400,
      "errors.imageTooManyPixels",
      { max: LOGO_MAX_PIXELS, dimensions: `${LOGO_MAX_SIDE}×${LOGO_MAX_SIDE}` },
    );
  }
  // ONE NAME PER UPLOAD, which is what makes everything below short. The configured file is never
  // written to, moved or copied: these bytes land under a name nothing references yet, and the row
  // write is what starts referencing it.
  //
  // Three things follow, and each was a mechanism here before. A reader mid-render cannot be handed
  // a half-written file, because nothing overwrites one. Two overlapping uploads cannot interleave
  // into a row that describes the other one's image, because they never share a path. And a failure
  // needs no compensation at all: the bytes it wrote are bytes nobody can be pointing at, so they
  // are dropped by the same question that drops a superseded letterhead — is this key referenced?
  //
  // What that replaced: a copy-aside of the live file, a rename over it, and a rollback that had to
  // decide between putting the copy back, removing what it wrote, and doing nothing, from outside
  // the lock it published under. Three review rounds went into that decision and the third found a
  // state it could not answer: two uploads whose row writes both failed, whose compensations ran in
  // the wrong order, left an uncommitted image as the live letterhead while the settings still
  // described the old one.
  const key = logoKeyFor(ctx.tenantId, ext);
  await Bun.write(logoPath(key), bytes);
  // The block as it stood UNDER the lock — the only reading of it that is not already stale, and
  // the one that names the file this write supersedes. `reached` is a separate flag because
  // `key` is legitimately null when there was no letterhead before.
  const superseded: { key: string | null; reached: boolean } = {
    key: null,
    reached: false,
  };
  try {
    const saved = await setCompanyLogoKey(
      ctx,
      key,
      base,
      Date.now(),
      async (current) => {
        superseded.key = current.logoKey;
        superseded.reached = true;
      },
    );
    // AFTER the row commits: the key this write replaced is referenced by nothing, so its file is
    // disk nobody will ever read again.
    await dropUnreferencedLogo(ctx, base, superseded.key);
    return saved;
  } catch (e) {
    // Whether these bytes can be referenced at all is decided by how far the write got, and the two
    // answers want different things.
    //
    // The write never reached the lock (it failed taking it, or reading the block): the transaction
    // cannot have written our key, so nothing can point at it and it goes — no question to ask, and
    // nothing to ask it of, since whatever broke is the same database.
    //
    // It did reach it: then the commit is genuinely ambiguous — a connection lost at COMMIT reports
    // a failure for a transaction the server kept — so the committed row is asked, under the lock,
    // exactly as a superseded key is. And if that question cannot be answered either, the file
    // STAYS: unreferenced bytes cost disk, while deleting a letterhead the settings do name leaves
    // every document rendering without one and nothing saying why.
    if (superseded.reached) await dropUnreferencedLogo(ctx, base, key);
    else await removeLogoFile(key);
    throw e;
  }
}

export async function clearCompanyLogo(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<CompanySettings> {
  const removed: { key: string | null } = { key: null };
  const cleared = await setCompanyLogoKey(
    ctx,
    null,
    base,
    Date.now(),
    async (current) => {
      removed.key = current.logoKey;
    },
  );
  // AFTER the row commits, never before: removing first and failing the write would leave the
  // settings pointing at a file that is gone, which is the one state every render has to handle and
  // none of them should have to. Clearing the key alone left the image on disk and in every backup
  // taken after it — an operator asking for it to be gone means gone.
  await dropUnreferencedLogo(ctx, base, removed.key);
  return cleared;
}

// Delete the file a key names, once nothing refers to it any more.
//
// Both callers reach here AFTER their own transaction committed, so the lock they held is gone and
// the key they are about to delete may have been re-published by someone else in between: two
// cross-format uploads racing (A commits png→jpg, B commits jpg→png, A then deletes B's live png),
// or a clear followed immediately by an upload. The committed state is the only authority on what
// is still referenced, and reading it under the lock is what stops a delete from landing between
// the read and the write that re-adopts the key.
//
// Best-effort past that point: the row no longer refers to the file, so a failure here costs disk
// and nothing else — refusing the operation over it would be worse.
async function dropUnreferencedLogo(
  ctx: TenantContext,
  base: PrismaClient,
  key: string | null,
): Promise<void> {
  if (!key) return;
  await withCompanyLock(ctx, base, async (current) => {
    if (current.logoKey === key) return;
    await removeLogoFile(key);
  }).catch(() => undefined);
}

// The file a key names, if it names one. Best-effort by design: the row no longer references it, so
// a failure here costs disk and nothing else — refusing the operation over it would be worse.
async function removeLogoFile(key: string | null): Promise<void> {
  if (!key || !logoExtOf(key)) return;
  await rm(logoPath(key), { force: true }).catch(() => undefined);
}

export interface CompanyLogo {
  data: Buffer;
  format: "png" | "jpg";
}

// Returns null for every "there is no usable logo" case — not configured, wrong extension, file
// gone. A missing logo must never fail a render: the document still has to reach the customer, and
// it reads fine with a typographic header.
export async function readCompanyLogo(
  company: CompanySettings,
): Promise<CompanyLogo | null> {
  if (!company.logoKey) return null;
  const format = logoExtOf(company.logoKey);
  if (!format) return null;
  // The read itself can fail, and an `exists()` check does not cover it: a clear or a cross-format
  // replacement unlinks this very file, and landing between the check and the read turns a MISSING
  // logo — the case this function exists to absorb — into a rejected promise that aborts the whole
  // preview or issuance. Every reason the bytes are unavailable has to come out as the same null.
  //
  // NOT COVERED BY A TEST: reaching it needs the unlink to land between two statements here, which
  // no single-process test can schedule. The stand-ins that ARE reachable (a missing file, a
  // directory at this path) answer null with or without the catch, so a test on one of them would
  // pass for the wrong reason. The property is structural instead: there is one exit, and it is
  // null.
  const bytes = await Bun.file(logoPath(company.logoKey))
    .arrayBuffer()
    .catch(() => null);
  if (!bytes) return null;
  return { data: Buffer.from(bytes), format };
}
