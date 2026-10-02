import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { TenantTargetRequiredError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { normalizeVi } from "./scorer";
import { kickOffTagging, type TaggingDeps } from "./tagging";

// Catalog CSV/JSON import (PIM-lite). Rows arrive as objects keyed by the
// header names below (`name,price,stock,description,tags`) or already-shaped
// JSON objects from the {rows:[...]} body. `?dryRun=true` runs the same parse
// and validation but writes nothing, so the console can show a preview table
// before the operator commits.

export interface ImportRowInput {
  name?: unknown;
  price?: unknown;
  stock?: unknown;
  description?: unknown;
  tags?: unknown;
}

export interface ValidatedImportRow {
  // 1-based line number in the source document, for the preview table.
  line: number;
  data: {
    name: string;
    price: number;
    stock: number;
    description: string | null;
    tags: string[];
  } | null;
  // Per-row refusal reasons, in English; the preview renders them verbatim.
  errors: string[];
}

export interface ImportPreview {
  rows: ValidatedImportRow[];
  // Rows that would write; `rows.length - ok` is the error count.
  ok: number;
}

// The CSV vocabulary. `tags` cells split on `|` (a comma inside a quoted cell
// would work too, but one visible separator keeps the template explainable).
const HEADER_ALIASES: Record<string, keyof ImportRowInput> = {
  name: "name",
  price: "price",
  stock: "stock",
  description: "description",
  tags: "tags",
  // Vietnamese spellings a shopkeeper's own sheet is likely to carry.
  ten: "name",
  gia: "price",
  ton: "stock",
  "ton kho": "stock",
  "mo ta": "description",
  tag: "tags",
  "the loai": "tags",
};

// A minimal RFC-4180-ish reader: handles quoted cells ("" escape), commas and
// newlines inside quotes. Anything more elaborate is out of scope for the lite
// importer — a row that does not fit this grammar lands as a validation error,
// not a silent mis-parse.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);
  // Drop trailing fully-empty rows (a file ending in a newline).
  for (;;) {
    const last = rows.at(-1);
    if (!last?.every((c) => c === "")) break;
    rows.pop();
  }
  return rows;
}

export function csvToRowInputs(text: string): ImportRowInput[] {
  // Strip a BOM; the first row is the header, mapped through the alias table.
  const grid = parseCsv(text.replace(/^﻿/, ""));
  const headerRow = grid[0];
  if (!headerRow) return [];
  const header = headerRow.map(
    (h) => HEADER_ALIASES[normalizeVi(h).trim()] ?? null,
  );
  return grid.slice(1).map((cells) => {
    const out: ImportRowInput = {};
    header.forEach((key, i) => {
      if (key && cells[i] !== undefined) out[key] = cells[i];
    });
    return out;
  });
}

const rowDataSchema = z.object({
  name: z.string().min(1).max(300),
  // VND zero-decimal; a string cell is coerced so the CSV column can stay text.
  price: z.coerce.number().min(0).max(999999999999999),
  stock: z.coerce.number().int().min(0).default(0),
  description: z
    .string()
    .max(5000)
    .nullish()
    .transform((v) => (v?.trim() ? v : null)),
  tags: z
    .union([
      z.array(z.string().min(1).max(100)),
      // The CSV cell spelling: "serum|trị mụn|BHA".
      z.string().transform((s) => s.split("|").map((t) => t.trim())),
    ])
    .default([])
    .transform((tags) =>
      [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 50),
    ),
});

export function validateImportRows(
  inputs: ImportRowInput[],
  lineOffset = 2,
): ImportPreview {
  const rows = inputs.map((input, i) => {
    const parsed = rowDataSchema.safeParse(input);
    if (parsed.success) {
      return { line: i + lineOffset, data: parsed.data, errors: [] };
    }
    const errors = parsed.error.issues.map((issue) => {
      const field = issue.path.join(".") || "row";
      return `${field}: ${issue.message}`;
    });
    return { line: i + lineOffset, data: null, errors };
  });
  return { rows, ok: rows.filter((r) => r.data !== null).length };
}

export interface ImportApplyResult {
  created: number;
  updated: number;
  // Ids of every written row; the controller kicks the tagger off for each.
  productIds: string[];
}

// Upserts by (tenant, name): the catalog has no unique key on name, so the
// upsert is a findFirst + create|update inside one scoped transaction per the
// batch. Tags from the file REPLACE on update (the CSV is the operator's
// stated list, not a merge suggestion).
export async function applyMerchantImport(
  ctx: TenantContext,
  rows: ValidatedImportRow[],
  opts: { base?: PrismaClient; tagging?: TaggingDeps | false } = {},
): Promise<ImportApplyResult> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const base = opts.base ?? basePrisma;
  const valid = rows.filter(
    (
      r,
    ): r is ValidatedImportRow & {
      data: NonNullable<ValidatedImportRow["data"]>;
    } => r.data !== null,
  );
  const written = await runScopedOn(base, ctx, async (db) => {
    let created = 0;
    let updated = 0;
    const productIds: string[] = [];
    for (const { data } of valid) {
      const existing = await db.merchantProduct.findFirst({
        where: { name: data.name },
        select: { id: true },
      });
      const payload = {
        name: data.name,
        description: data.description,
        price: data.price,
        stock: data.stock,
        tags: data.tags,
      };
      let id: bigint;
      if (existing) {
        id = (
          await db.merchantProduct.update({
            where: { id: existing.id },
            data: payload,
            select: { id: true },
          })
        ).id;
        updated++;
      } else {
        id = (
          await db.merchantProduct.create({
            data: { tenantId, ...payload },
            select: { id: true },
          })
        ).id;
        created++;
      }
      productIds.push(String(id));
      await auditMutation(db, ctx, {
        action: existing
          ? "merchant_product.update"
          : "merchant_product.create",
        target: `merchant_product:${id}`,
        after: payload,
      });
    }
    return { created, updated, productIds };
  });
  if (opts.tagging !== false) {
    for (const id of written.productIds) {
      kickOffTagging(ctx, BigInt(id), opts.tagging ?? {});
    }
  }
  return written;
}
