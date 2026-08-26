import { type ZodError, z } from "zod";
import { AppError } from "@/lib/errors";
import { unstorableProblem } from "@/lib/text";
import {
  blockCanDraw,
  type DocumentBlock,
  type DocumentField,
  type DocumentStyle,
  documentBlockSchema,
  documentFieldSchema,
  documentStyleSchema,
  MAX_BLOCKS_PER_DOCUMENT,
  MAX_DOCUMENT_AMOUNT,
  MAX_FIELDS_PER_DOCUMENT,
  MAX_LINE_ITEMS,
  MAX_TOKENS_PER_DOCUMENT,
  parseDocumentStyle,
} from "./blocks";
import { unprintableProblem } from "./printable";
import {
  DOCUMENT_TOKEN_RE,
  isReservedTokenName,
  malformedTokenIn,
  RESERVED_TOKEN_NAMES,
  sanitizeDocumentValue,
  tokensIn,
} from "./tokens";

// Everything that REFUSES a template or a set of values, as one pure decision with a decision table
// behind it. Written for whoever authored the thing, because the caller on the far end is either an
// operator in the console or a model composing a write over MCP — neither can read our source to
// find out what "invalid" meant.
//
// The rule the whole file exists for: a token that resolves to nothing must be caught HERE, at
// authoring time. Downstream it becomes a blank space in a document a customer keeps, and nothing
// anywhere reports it.

function issues(e: ZodError): string {
  return e.issues
    .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
    .join("; ");
}

export const documentBlocksSchema = z.array(documentBlockSchema);
export const documentFieldsSchema = z.array(documentFieldSchema);

export interface ParsedTemplateContent {
  blocks: DocumentBlock[];
  fields: DocumentField[];
}

export type TemplateParse =
  | { ok: true; content: ParsedTemplateContent }
  | { ok: false; reason: string };

const BLOCK_TYPES_HINT =
  'blocks are {"type":"header"|"text"|"fields"|"lineItems"|"totals"|"divider", "id":"…"}';

// Which declared field a block needs, and of which type. Kept as data so the check below reads as
// one loop rather than a branch per block type — a seventh block that points at a field is then one
// row here instead of a case somebody forgets.
interface FieldRef {
  prop: string;
  name: string;
  types: DocumentField["type"][];
}

function fieldRefs(block: DocumentBlock): FieldRef[] {
  switch (block.type) {
    case "lineItems":
      return [{ prop: "field", name: block.field, types: ["lineItems"] }];
    case "totals": {
      const refs: FieldRef[] = [
        { prop: "field", name: block.field, types: ["lineItems"] },
      ];
      if (block.discountField) {
        refs.push({
          prop: "discountField",
          name: block.discountField,
          types: ["currency", "number"],
        });
      }
      if (block.taxField) {
        refs.push({
          prop: "taxField",
          name: block.taxField,
          types: ["currency", "number"],
        });
      }
      return refs;
    }
    default:
      return [];
  }
}

// Every piece of a block that a token may appear in. A token in a header's `meta` value is as
// customer-visible as one in a paragraph, and listing the places once is what keeps a new
// text-carrying property from being the one nobody validates.
function textsIn(block: DocumentBlock): string[] {
  switch (block.type) {
    case "header":
      return [
        block.title ?? "",
        block.subtitle ?? "",
        ...(block.meta ?? []).flatMap((m) => [m.label, m.value]),
      ];
    case "text":
      return [block.text];
    case "fields":
      return block.rows.flatMap((r) => [r.label, r.value]);
    default:
      return [];
  }
}

// ── two questions, deliberately answered differently ──
//
// Reading a STORED row is tolerant: a template written by a newer build has to keep rendering, so a
// property this version does not know is dropped rather than fatal, and an unusable style falls back
// to defaults instead of taking the console down. That is `parseTemplateContent`.
//
// Reading an AUTHORED template is strict: what the operator wrote either takes effect or comes back
// refused BY NAME. That is `parseAuthoredTemplate`, and it is the one every write goes through — the
// console, the REST route, the MCP write, and an imported bundle, which is authored content arriving
// from outside. Anything less makes the transport's permissiveness pointless: the whole reason the
// route accepts an undeclared shape is so the SERVICE can say what is wrong with it.
//
// The style is taken as well as the blocks because the footer is rendered through the same token
// resolver the block texts are: a typo there resolves to a blank on the last line of every page of a
// document the customer keeps. It is a required argument, not an optional one — a check worth having
// is not one each caller can skip by leaving an argument out.

// Zod strips what it does not know, which is exactly right for a stored row and exactly wrong for a
// write. Rather than keep a second, strict copy of every schema in blocks.ts — which would have to
// be kept in step with the first one forever, and would still miss the nested rows — the write path
// compares what came back against what it was given and names the first key that did not survive.
// One mechanism, and it reaches every level: block, nested meta row, field, style.
function droppedKey(
  input: unknown,
  parsed: unknown,
  path: string,
): string | null {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    for (let i = 0; i < input.length && i < parsed.length; i++) {
      const found = droppedKey(input[i], parsed[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(input) || !isPlainObject(parsed)) return null;
  for (const key of Object.keys(input)) {
    // `undefined` is how an absent optional arrives over JSON round-trips; it was never a value.
    if (input[key] === undefined) continue;
    // Object.hasOwn, not `in`: `"constructor" in {}` is true through the prototype chain, so a
    // submitted `constructor` or `__proto__` would read as "kept" while Zod had stripped it — the
    // one shape of unknown key this check was blind to.
    if (!Object.hasOwn(parsed, key)) return path ? `${path}.${key}` : key;
    const found = droppedKey(
      input[key],
      parsed[key],
      path ? `${path}.${key}` : key,
    );
    if (found) return found;
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The style, strictly, on its OWN — separable because a PATCH validates the caller's style against
// the stored one merged underneath it, and the strict question is only ever about the half the
// caller wrote. The tolerant reader answers ANY invalid value by returning every default, so an
// operator who mistyped one colour would have their font, margin and currency silently replaced too
// — and be told it saved.
export function authoredStyleProblem(rawStyle: unknown): string | null {
  const styleIn = rawStyle ?? {};
  const parsed = documentStyleSchema.partial().safeParse(styleIn);
  if (!parsed.success) return `style: ${issues(parsed.error)}`;
  const dropped = droppedKey(styleIn, parsed.data, "");
  if (dropped) {
    return `style: "${dropped}" is not a style property, so it would be stored and never take effect. Check the spelling against document_template_schema, or remove it.`;
  }
  // The style the CALLER sent, checked for printability here rather than through the authored-halves
  // pass: a partial style patch is never marked as an authored half (the value validated there is
  // the patch merged over the STORED style, which the caller did not write), so this is the only
  // place that sees `footerText` as something a caller just typed.
  for (const [key, value] of Object.entries(
    (styleIn ?? {}) as Record<string, unknown>,
  )) {
    if (typeof value !== "string") continue;
    const problem = unprintableProblem(value, `style.${key}`);
    if (problem) return problem;
  }
  return null;
}

export interface ParsedAuthoredTemplate {
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
}

export type AuthoredTemplateParse =
  | { ok: true; content: ParsedAuthoredTemplate }
  | { ok: false; reason: string };

// Which halves the CALLER wrote. The strict pass applies to those and only those: a half that came
// out of storage is the newer build's, and refusing an ordinary save because a column carries a
// property this version does not know would make every such save impossible — the opposite of the
// tolerance storage is supposed to have. Defaults to all three, which is every path except an
// update patching one half.
export interface AuthoredHalves {
  blocks?: boolean;
  fields?: boolean;
  style?: boolean;
}

export function parseAuthoredTemplate(
  rawBlocks: unknown,
  rawFields: unknown,
  rawStyle: unknown,
  authored: AuthoredHalves = { blocks: true, fields: true, style: true },
): AuthoredTemplateParse {
  const blocksIn = rawBlocks ?? [];
  const fieldsIn = rawFields ?? [];
  const styleIn = rawStyle ?? {};

  const shared = parseTemplateContent(blocksIn, fieldsIn, styleIn);
  if (!shared.ok) return shared;

  for (const [label, input, parsed] of (
    [
      ["blocks", blocksIn, shared.content.blocks],
      ["fields", fieldsIn, shared.content.fields],
    ] as const
  ).filter(([label]) => authored[label])) {
    const dropped = droppedKey(input, parsed, "");
    if (dropped) {
      return {
        ok: false,
        reason: `${label}: "${dropped}" is not a property this version understands, so it would be stored and never take effect. Check the spelling against document_template_schema, or remove it.`,
      };
    }
  }

  if (Array.isArray(fieldsIn) && fieldsIn.length > MAX_FIELDS_PER_DOCUMENT) {
    return {
      ok: false,
      reason: `fields: at most ${MAX_FIELDS_PER_DOCUMENT} per document, got ${fieldsIn.length} — the declared fields become the agent's tool schema, published on every turn.`,
    };
  }

  if (authored.style) {
    const problem = authoredStyleProblem(styleIn);
    if (problem) return { ok: false, reason: problem };
  }

  // A layout that draws NOTHING is not a document. `blocks` defaults to [] and templates default to
  // enabled, so an omitted layout became a granted tool that issued a numbered, blank PDF — burning
  // a number from the template's sequence and attaching an empty page to a customer's conversation.
  // A divider on its own is the same thing, and so is a text block with no text: the rule is about
  // what PRINTS, not about the count. Only the UNCONDITIONAL half is asked here — whether a given
  // document draws depends on values that arrive at the turn, and that is settled exactly by
  // documentDraws before a number is assigned.
  if (authored.blocks) {
    if (!shared.content.blocks.some(blockCanDraw)) {
      return {
        ok: false,
        reason:
          "blocks: a document needs at least one block that can print something (header, text, fields, lineItems or totals) — as written, every issued document would be a numbered blank page.",
      };
    }
  }

  // What the AUTHOR wrote has to be printable, checked here and not in the shared parse: content
  // that came out of storage belongs to whoever wrote it, and refusing to load a template because a
  // newer build put an emoji in it would make it uneditable rather than fixable.
  // Clamped, not refused: baseFontSize is a SIZE, and sizes are clamped by contract (docs/mcp.md).
  // The clamp changes a value, never a key, so it survives the check above.
  const style = parseDocumentStyle(styleIn);
  const { printed, structural } = authoredText(
    { ...shared.content, style },
    authored,
  );
  for (const [label, text] of printed) {
    const problem = unprintableProblem(text, label);
    if (problem) return { ok: false, reason: problem };
  }
  // The other question, asked of the keys the loop above deliberately skips: printable and storable
  // are different rules, and an id is held only to the second one.
  for (const [label, text] of structural) {
    const problem = unstorableProblem(text, label);
    if (problem) return { ok: false, reason: problem };
  }

  return { ok: true, content: { ...shared.content, style } };
}

// Keys that NAME something rather than print it: an id, a discriminator, a reference to a declared
// field, an enum list. Everything else in a block is drawn on the page.
//
// A deny-list, not an allow-list, and that is the point. Naming the printing keys is how a nested
// row gets missed — `header.meta[]` and `fields.rows[]` were, and they are exactly where an operator
// writes "Validade: 7 dias". A block type added later prints by default here; only a new STRUCTURAL
// key needs a line, and forgetting one costs a refusal on a value already constrained to an
// identifier, which shows up immediately instead of silently.
const NON_PRINTING_KEYS = new Set([
  "id",
  "type",
  "spaceAfter",
  "field",
  "discountField",
  "taxField",
  "columns",
  "align",
  "variant",
  "name",
]);

// Every string a template PRINTS, from the halves the caller wrote. Nested objects are walked, so a
// label inside a header's meta row or a fields block's rows is found the same way a title is.
function walkStrings(
  value: unknown,
  path: string,
  out: [string, string][],
  structural?: [string, string][],
): void {
  if (typeof value === "string") {
    out.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walkStrings(item, `${path}[${i}]`, out, structural);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (NON_PRINTING_KEYS.has(key)) {
      // COLLECTED, not skipped. Being unprintable is fine for a key that names something instead of
      // drawing it; being unstorable is not, and these land in a `jsonb` column like every other
      // half. Postgres refuses a NUL or a lone surrogate there, so the write that accepted the id
      // fails at the INSERT with a driver error, and an imported bundle takes its whole transaction
      // down with it — after the preview rendered happily, because a preview writes nothing.
      //
      // Only `id` actually reaches the column unchecked today. Four of these keys take an arbitrary
      // string at the schema (`id`, `field`, `discountField`, `taxField`; the rest are enums or an
      // identifier regex), but the three `*Field` ones are then pinned to a DECLARED field name,
      // which is `[a-z][a-z0-9_]{0,39}` — measured: a NUL in any of them is refused as an undeclared
      // reference before it gets here. Sweeping the whole deny-list anyway is the same bet the list
      // itself makes: that check is a different rule and could move, and a structural key added
      // later is covered without anyone remembering this paragraph.
      if (typeof child === "string") structural?.push([here, child]);
      continue;
    }
    walkStrings(child, here, out, structural);
  }
}

function authoredText(
  content: {
    blocks: DocumentBlock[];
    fields: DocumentField[];
    style?: DocumentStyle;
  },
  authored: AuthoredHalves,
): { printed: [string, string][]; structural: [string, string][] } {
  const printed: [string, string][] = [];
  const structural: [string, string][] = [];
  if (authored.blocks) {
    for (const block of content.blocks) {
      walkStrings(block, `blocks."${block.id}"`, printed, structural);
    }
  }
  if (authored.fields) {
    for (const field of content.fields) {
      walkStrings(field, `fields."${field.name}"`, printed, structural);
    }
  }
  const footer = content.style?.footerText;
  if (authored.style && footer) {
    printed.push(["style.footerText", footer]);
  }
  return { printed, structural };
}

export function parseTemplateContent(
  rawBlocks: unknown,
  rawFields: unknown,
  rawStyle: unknown,
): TemplateParse {
  const blocksParsed = documentBlocksSchema.safeParse(rawBlocks ?? []);
  if (!blocksParsed.success) {
    return {
      ok: false,
      reason: `blocks: ${issues(blocksParsed.error)} — ${BLOCK_TYPES_HINT}.`,
    };
  }
  const fieldsParsed = documentFieldsSchema.safeParse(rawFields ?? []);
  if (!fieldsParsed.success) {
    return { ok: false, reason: `fields: ${issues(fieldsParsed.error)}` };
  }
  const blocks = blocksParsed.data;
  const fields = fieldsParsed.data;

  if (blocks.length > MAX_BLOCKS_PER_DOCUMENT) {
    return {
      ok: false,
      reason: `blocks: at most ${MAX_BLOCKS_PER_DOCUMENT} per document, got ${blocks.length}.`,
    };
  }

  const seenBlockIds = new Set<string>();
  for (const b of blocks) {
    if (seenBlockIds.has(b.id)) {
      return {
        ok: false,
        reason: `blocks: duplicate block id "${b.id}" — ids address a block across reorders, so two blocks cannot share one.`,
      };
    }
    seenBlockIds.add(b.id);
  }

  const byName = new Map<string, DocumentField>();
  for (const f of fields) {
    if (byName.has(f.name)) {
      return { ok: false, reason: `fields: duplicate field name "${f.name}".` };
    }
    if (isReservedTokenName(f.name)) {
      return {
        ok: false,
        reason: `fields: "${f.name}" starts with a reserved prefix (company_, empresa_, doc_, documento_) — those names already resolve to the company profile or the document itself, and a field would shadow them silently.`,
      };
    }
    byName.set(f.name, f);
  }

  for (const b of blocks) {
    for (const ref of fieldRefs(b)) {
      const target = byName.get(ref.name);
      if (!target) {
        return {
          ok: false,
          reason: `blocks: ${b.type} block "${b.id}" points ${ref.prop} at "${ref.name}", which is not a declared field.`,
        };
      }
      if (!ref.types.includes(target.type)) {
        return {
          ok: false,
          reason: `blocks: ${b.type} block "${b.id}" needs ${ref.prop} to name a field of type ${ref.types.join(" or ")}, but "${ref.name}" is ${target.type}.`,
        };
      }
    }
    for (const text of textsIn(b)) {
      const fault = unknownToken(text, byName);
      if (fault) {
        return {
          ok: false,
          reason: `blocks: ${tokenFaultReason(`block "${b.id}"`, fault)}`,
        };
      }
    }
  }

  // Counted with repeats, and across the whole template: the amplification is a property of the
  // document, not of one block, and 60 blocks of two tokens each cost the same as one block of 120.
  let tokenCount = 0;
  for (const b of blocks) {
    for (const text of textsIn(b)) {
      tokenCount += [...text.matchAll(DOCUMENT_TOKEN_RE)].length;
    }
  }
  const footer = parseDocumentStyle(rawStyle).footerText;
  tokenCount += footer ? [...footer.matchAll(DOCUMENT_TOKEN_RE)].length : 0;
  if (tokenCount > MAX_TOKENS_PER_DOCUMENT) {
    return {
      ok: false,
      reason: `blocks: at most ${MAX_TOKENS_PER_DOCUMENT} {{tokens}} per document, counting repeats, got ${tokenCount} — each one expands to a value of up to 2000 characters when the document is issued.`,
    };
  }

  const footerFault = footer ? unknownToken(footer, byName) : null;
  if (footerFault) {
    return {
      ok: false,
      reason: `style: ${tokenFaultReason("footerText", footerFault)}`,
    };
  }

  return { ok: true, content: { blocks, fields } };
}

// One question, asked of every text that reaches resolveTokens: block texts and the style's footer
// alike. Returns the first token that would render as a blank, or null.
type TokenFault =
  | { kind: "malformed"; text: string }
  | { kind: "unknown"; name: string }
  | { kind: "notScalar"; name: string };

function unknownToken(
  text: string,
  byName: Map<string, DocumentField>,
): TokenFault | null {
  // Malformed first, and reported as its own kind. A {{Company_name}} or {{company-name}} matches
  // nothing the resolver looks for, so `tokensIn` cannot see it — authoring accepted it and the
  // braces printed verbatim in a document the customer keeps. It also needs different advice:
  // "declare it in fields" is the fix for an unknown NAME, and no field can be declared under a
  // name the token syntax cannot express.
  const malformed = malformedTokenIn(text);
  if (malformed) return { kind: "malformed", text: malformed };
  for (const token of tokensIn(text)) {
    // A lineItems field is DECLARED, so it passes the "is this a known name" test — and resolves to
    // the empty string, because a table is not a token (see vars.ts). Accepting it here means
    // authoring succeeds and the customer's document carries a blank exactly where the operator
    // expected their items. It is refused with its own reason: the fix is a lineItems BLOCK, not a
    // different token.
    if (byName.get(token)?.type === "lineItems") {
      return { kind: "notScalar", name: token };
    }
    if (byName.has(token) || RESERVED_TOKEN_NAMES.includes(token)) continue;
    return { kind: "unknown", name: token };
  }
  return null;
}

// One sentence per fault kind, written for whoever authored the template.
function tokenFaultReason(where: string, fault: TokenFault): string {
  switch (fault.kind) {
    case "malformed":
      return `${where} uses ${fault.text}, which is not a readable token: a name must start with a lowercase letter and contain only lowercase letters, digits and underscores. As written it would print with its braces in the customer's document.`;
    case "notScalar":
      return `${where} uses {{${fault.name}}}, which is a lineItems field. A table cannot be printed as a token — it renders as a blank. Use a lineItems block to show those items.`;
    default:
      return `${where} uses {{${fault.name}}}, which is neither a declared field nor a reserved name. Declare it in fields, or remove it — an unresolved token renders as a blank space in the customer's document.`;
  }
}

// ── values (what one issuance supplies) ──

// STRICT, like the tool schema the model sees: a key this shape does not know is refused, not
// stripped. Stripped, a caller that put a discount inside a line item got a 200 and a document
// without it — and the value it wrote was even kept in the snapshot, ignored by the renderer, which
// is the most confusing version of that outcome.
export const lineItemValueSchema = z
  .object({
    description: z.string().min(1).max(500),
    quantity: z.number().finite().nonnegative(),
    unitPrice: z.number().finite().nonnegative(),
  })
  .strict();
export type LineItemValue = z.infer<typeof lineItemValueSchema>;

export type DocumentValue = string | number | LineItemValue[];
export type DocumentValues = Record<string, DocumentValue>;

export type ValuesParse =
  | { ok: true; values: DocumentValues }
  | { ok: false; reason: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// The shape is not the rule. "2026-02-31" matches the pattern, and neither the renderer nor
// Intl refuses it — JavaScript rolls it forward to March 3, so the customer keeps a PDF carrying a
// date nobody typed and no error is ever raised. Round-tripping through UTC is what separates a
// date that exists from a string that looks like one.
function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  // TWO clauses, not three. Over every string the regex above admits (110_000 of them, measured),
  // comparing the year and the day agrees with also comparing the month on every single input: a day
  // that overflows lands on another day, and a month outside 1..12 lands in another year. The third
  // clause decides nothing, and a rule carrying a clause that decides nothing is one nobody can
  // safely edit later.
  return at.getUTCFullYear() === year && at.getUTCDate() === day;
}

function valueProblem(field: DocumentField, value: unknown): string | null {
  switch (field.type) {
    case "text":
      return typeof value === "string" && value.length <= 2_000
        ? null
        : "must be a string of at most 2000 characters";
    case "number":
    case "currency":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "must be a finite number";
      }
      // Finite is not enough: the arithmetic is in integer cents, and 1e308 is finite right up to
      // the point where it becomes Infinity in cents and prints as a total nobody can read.
      return Math.abs(value) <= MAX_DOCUMENT_AMOUNT
        ? null
        : `must be at most ${MAX_DOCUMENT_AMOUNT}`;
    case "date":
      // NOTE: ISO date only, never a pre-formatted string. The document is rendered in the
      // template's locale, and a date the model already wrote as "22/08" cannot be reformatted —
      // an en-US document would then carry one Brazilian date in the middle of it.
      return typeof value === "string" && isCalendarDate(value)
        ? null
        : "must be an ISO date (YYYY-MM-DD)";
    case "lineItems": {
      if (!Array.isArray(value)) return "must be a list of line items";
      if (value.length > MAX_LINE_ITEMS) {
        return `must have at most ${MAX_LINE_ITEMS} line items`;
      }
      const parsed = z.array(lineItemValueSchema).safeParse(value);
      if (!parsed.success) {
        return `line items: ${issues(parsed.error)} — each is {"description":"…","quantity":n,"unitPrice":n}`;
      }
      // A description is PRINTED on a priced row, so it has to survive sanitising like any other
      // required text: `min(1)` counts whitespace, which would put a blank line carrying a price on
      // a numbered financial document.
      //
      // And what survives sanitising is what gets STORED (below), not just what gets tested. The
      // renderer prints an item's description directly — unlike a field value, which passes through
      // the token resolver's sanitiser — so a tab or a control character in it reaches the PDF and
      // rearranges the table it sits in.
      for (const item of parsed.data) {
        if (sanitizeDocumentValue(item.description).trim() === "") {
          return "line items: every item needs a description that is not blank once whitespace and control characters are removed";
        }
      }
      // The factors AND their product. Each factor is PRINTED on the line, so a quantity of 1e308
      // against a unit price of zero keeps the product inside the cap and still puts an unreadable
      // number in front of the customer — the first version of this check looked only at the
      // product and let exactly that through.
      for (const item of parsed.data) {
        if (
          item.quantity > MAX_DOCUMENT_AMOUNT ||
          item.unitPrice > MAX_DOCUMENT_AMOUNT
        ) {
          return `line items: "${item.description}" has a quantity or unit price above ${MAX_DOCUMENT_AMOUNT}`;
        }
        if (item.quantity * item.unitPrice > MAX_DOCUMENT_AMOUNT) {
          return `line items: "${item.description}" totals more than ${MAX_DOCUMENT_AMOUNT}`;
        }
      }
      return null;
    }
  }
}

export function parseDocumentValues(
  fields: DocumentField[],
  raw: unknown,
): ValuesParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      reason: "values must be an object keyed by field name.",
    };
  }
  const input = raw as Record<string, unknown>;
  const declared = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      return {
        ok: false,
        reason: `values: "${key}" is not a declared field of this template (declared: ${[...declared].join(", ") || "none"}).`,
      };
    }
  }
  const values: DocumentValues = {};
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined || value === null || value === "") {
      if (field.required) {
        return {
          ok: false,
          reason: `values: "${field.name}" (${field.label}) is required.`,
        };
      }
      continue;
    }
    // An empty list is PRESENT, so it clears the check above and the array parser finds nothing to
    // object to — which would let an agent issue a numbered quote with no rows and a total of zero
    // in front of a customer, with every gate reporting success. Required means the document ends up
    // with the thing. An optional list stays free to be empty: nothing was promised, and the block
    // renders empty.
    if (field.required && Array.isArray(value) && value.length === 0) {
      return {
        ok: false,
        reason: `values: "${field.name}" (${field.label}) is required, so it needs at least one item.`,
      };
    }
    // The same rule for text, against what will actually PRINT. "   " and a string of control
    // characters are non-empty here and empty after sanitising, so a required customer name could
    // clear every gate and come out as a blank line on a numbered document. What survives
    // sanitising is what the customer reads, so that is what "required" has to be about.
    if (
      field.required &&
      typeof value === "string" &&
      sanitizeDocumentValue(value).trim() === ""
    ) {
      return {
        ok: false,
        reason: `values: "${field.name}" (${field.label}) is required, and this value is blank once whitespace and control characters are removed.`,
      };
    }
    const problem = valueProblem(field, value);
    if (problem) {
      return { ok: false, reason: `values: "${field.name}" ${problem}.` };
    }
    // Every string that will be PRINTED, including the description of each line item. A model
    // writes these, and a model reaches for an emoji or a customer's name in its own script without
    // being asked; printed as-is they come out as a different Latin character (see printable.ts).
    // Refused rather than stripped, because the tool's error is something the model can act on and
    // a quietly shortened name in a customer's receipt is not.
    for (const text of printedStrings(field, value)) {
      const unprintable = unprintableProblem(text, `values: "${field.name}"`);
      if (unprintable) return { ok: false, reason: unprintable };
    }
    // Line items are stored PARSED and sanitised: the snapshot then holds exactly what the renderer
    // will print, which is the whole point of freezing it.
    values[field.name] =
      field.type === "lineItems"
        ? (z
            .array(lineItemValueSchema)
            // not-caller-input: inside a validator whose contract is { ok: false, reason }, not a throw
            .parse(value)
            .map((item) => ({
              ...item,
              description: sanitizeDocumentValue(item.description),
            })) as DocumentValue)
        : // Text is stored SANITISED too, for the same reason line items are: the snapshot has to hold
          // exactly what the renderer prints. Storing the raw string made the two disagree about a
          // character the check above had already normalised away — and since the snapshot is a
          // `jsonb` column, a lone surrogate in it does not print oddly, it makes Postgres refuse the
          // whole issuance.
          typeof value === "string"
          ? (sanitizeDocumentValue(value) as DocumentValue)
          : (value as DocumentValue);
  }
  return { ok: true, values };
}

// The strings a value contributes to the page: the value itself when it is text, and every line
// item's description when it is a table.
//
// SANITISED first, because that is the form that reaches the page — `resolveTokens` sanitises every
// substitution on the way in, and line-item descriptions are stored that way. A model's stray tab or
// bell is normalised to a space there by design, so checking the raw string would refuse text this
// project has already decided to accept and print. What is left after that normalisation is what has
// to be printable.
function printedStrings(field: DocumentField, value: unknown): string[] {
  if (typeof value === "string") return [sanitizeDocumentValue(value)];
  if (field.type !== "lineItems" || !Array.isArray(value)) return [];
  return value
    .map((item) => (item as { description?: unknown }).description)
    .filter((d): d is string => typeof d === "string")
    .map((d) => sanitizeDocumentValue(d));
}

// A refusal that keeps the REASON. The global error handler localizes `translationKey` and drops
// `message` when the key resolves, so a plain "errors.invalidDocumentTemplate" answers every
// malformed block, token, field and style with the same sentence — and the preview panel, whose
// entire purpose is to name the block and the rule that failed, then shows nothing an operator can
// act on. Passing the reason as an interpolation keeps the sentence around it translated while the
// specific half survives; the reason itself is the validator's own English, which is the language
// the block ids and property names it quotes are written in anyway.
export function invalidDocumentTemplate(reason: string): AppError {
  return new AppError(reason, 400, "errors.invalidDocumentTemplateReason", {
    reason,
  });
}
