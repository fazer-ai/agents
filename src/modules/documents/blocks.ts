import { z } from "zod";

// The vocabulary a document is written in, and the ONE place that says which shapes exist.
//
// A document is an ordered list of blocks, a list of `fields` the agent fills at issue time, and a
// `style`. The set is deliberately closed: every block is something the renderer knows how to lay
// out, so an operator authoring through the API cannot produce a document that renders as a
// surprise. What the set does not cover goes in a `text` block as prose — that is the escape hatch,
// and it is why there is no generic "html" or "raw" block.
//
// Pure and DB-free on purpose: the client bundle imports the same types, and the MCP write path
// validates with the same schemas the REST path does.

// Blocks carry their own id rather than being addressed by position. The UI edits the text of a
// `text` block; the API and MCP reorder freely. Addressing by index means a reorder from one
// transport makes the other write into the wrong block, and nothing would report it.
const blockBase = {
  id: z
    .string()
    .min(1)
    .max(40)
    .refine((id) => !isPrototypeName(id), {
      message: "is a property of every object, so it cannot be used as an id",
    }),
  spaceAfter: z.enum(["none", "sm", "md", "lg"]).optional(),
};

const metaRowSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.string().max(200),
});

export const headerBlockSchema = z.object({
  ...blockBase,
  type: z.literal("header"),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  showLogo: z.boolean().optional(),
  showCompany: z.boolean().optional(),
  meta: z.array(metaRowSchema).max(6).optional(),
});

export const textBlockSchema = z.object({
  ...blockBase,
  type: z.literal("text"),
  text: z.string().max(5_000),
  align: z.enum(["left", "center", "right"]).optional(),
  variant: z.enum(["body", "heading", "muted"]).optional(),
});

// Label/value pairs in aligned columns ("Validade: 7 dias", "Condições: 50% na aprovação"). Written
// as a block rather than left to prose because prose produces ragged columns, and ragged columns are
// most of what makes a commercial document look improvised.
export const fieldsBlockSchema = z.object({
  ...blockBase,
  type: z.literal("fields"),
  rows: z.array(metaRowSchema).min(1).max(20),
  columns: z.union([z.literal(1), z.literal(2)]).optional(),
});

export const LINE_ITEM_COLUMNS = [
  "description",
  "quantity",
  "unitPrice",
  "total",
] as const;
export type LineItemColumn = (typeof LINE_ITEM_COLUMNS)[number];

// The one block whose content is repeating structure rather than text, which is what makes a quote a
// document instead of a message. `field` names a declared field of type `lineItems`.
export const lineItemsBlockSchema = z.object({
  ...blockBase,
  type: z.literal("lineItems"),
  field: z.string().min(1).max(40),
  columns: z.array(z.enum(LINE_ITEM_COLUMNS)).min(1).max(4).optional(),
  showHeader: z.boolean().optional(),
});

export const TOTAL_ROWS = ["subtotal", "discount", "tax", "total"] as const;
export type TotalRow = (typeof TOTAL_ROWS)[number];

// Separate from `lineItems` because the two exist apart: a service order lists items with no total,
// a fixed-price proposal states a total with no table. The arithmetic is the renderer's, never the
// model's — a model that is asked to add up its own line items will eventually get it wrong in front
// of a customer, and the number it got wrong is a price.
export const totalsBlockSchema = z.object({
  ...blockBase,
  type: z.literal("totals"),
  field: z.string().min(1).max(40),
  rows: z.array(z.enum(TOTAL_ROWS)).min(1).max(4).optional(),
  discountField: z.string().max(40).optional(),
  taxField: z.string().max(40).optional(),
});

export const dividerBlockSchema = z.object({
  ...blockBase,
  type: z.literal("divider"),
});

export const documentBlockSchema = z.discriminatedUnion("type", [
  headerBlockSchema,
  textBlockSchema,
  fieldsBlockSchema,
  lineItemsBlockSchema,
  totalsBlockSchema,
  dividerBlockSchema,
]);
export type DocumentBlock = z.infer<typeof documentBlockSchema>;
export type DocumentBlockType = DocumentBlock["type"];

export const DOCUMENT_BLOCK_TYPES: DocumentBlockType[] = [
  "header",
  "text",
  "fields",
  "lineItems",
  "totals",
  "divider",
];

// ── fields: the contract the agent fills ──

export const FIELD_TYPES = [
  "text",
  "number",
  "date",
  "currency",
  "lineItems",
] as const;
export type DocumentFieldType = (typeof FIELD_TYPES)[number];

// `name` is token-safe BY CONSTRUCTION: the same character class the token resolver accepts, so a
// declared field is always addressable as {{name}} and no field can be declared that the resolver
// would then refuse to see.
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

// Names that are already properties of every plain object, plus the one that IS the prototype link.
//
// Both halves of this feature use caller-chosen names as keys of ordinary objects: values are keyed
// by field name, and the console's wording edits are keyed by block id. On such an object,
// `values.constructor` answers with a function nobody stored — so an optional field called
// `constructor`, omitted by the agent, arrives at validation as `[Function: Object]` and the write
// fails on a value the caller never sent. `__proto__` is worse and quieter: assigning to it sets the
// prototype instead of creating a property, so the console reports a saved edit it did not make.
//
// DERIVED, not listed: the set is whatever this runtime puts on Object.prototype, so it cannot go
// stale against a platform that adds one. `__proto__` is in it already — it is an accessor property
// declared there, and spelling it out separately was a clause that never ran. Refusing these two
// dozen names costs nothing real (none is a plausible name for a field or a block in a commercial
// document) and it means every lookup downstream can stay a plain property read.
const PROTOTYPE_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

export function isPrototypeName(name: string): boolean {
  return PROTOTYPE_NAMES.has(name);
}

export const documentFieldSchema = z.object({
  name: z
    .string()
    .regex(FIELD_NAME_RE)
    .refine((name) => !isPrototypeName(name), {
      message: "is a property of every object, so it cannot be used as a name",
    }),
  label: z.string().min(1).max(60),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  description: z.string().max(200).optional(),
});
export type DocumentField = z.infer<typeof documentFieldSchema>;

// ── style ──

// The three families @react-pdf/renderer ships built in. Deliberately not a bundled TTF: font files
// are megabytes in a public repo and resolve from a path that differs between the dev tree and the
// container, which is the failure the old renderer's header was written to avoid. Built-ins cover
// Latin-1, so PT-BR accents render. A bundled family is purely additive later.
export const DOCUMENT_FONTS = ["sans", "serif", "mono"] as const;
export type DocumentFont = (typeof DOCUMENT_FONTS)[number];

export const BASE_FONT_SIZE_MIN = 8;
export const BASE_FONT_SIZE_MAX = 14;

export const documentStyleSchema = z.object({
  font: z.enum(DOCUMENT_FONTS),
  // NOTE: no .min/.max, and the reader CLAMPS instead. "Type and choice, never size" (docs/mcp.md):
  // a bound copied into the schema turns a clamp into a refusal, so the same write would be accepted
  // in the console and rejected over MCP. The range lives in the description.
  baseFontSize: z.number().int(),
  // Written out rather than /^#[0-9a-f]{6}$/i: the `i` flag does not survive publication as JSON
  // Schema, and a client would then refuse what this server accepts.
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  margin: z.enum(["narrow", "normal", "wide"]),
  pageSize: z.enum(["A4", "LETTER"]),
  locale: z.enum(["pt-BR", "en-US"]),
  // Three ASCII LETTERS. Length alone accepted "$$$" and "中AB": the first makes Intl throw, and the
  // renderer's fallback then prints the raw code beside every amount; the second is drawn as a
  // different character in every price on the page.
  //
  // NOTE: no `.transform` to upper-case here — a transform does not survive z.toJSONSchema, and this
  // schema is published as the authoring contract. Case is normalised by parseDocumentStyle, beside
  // the baseFontSize clamp, for the same reason: "brl" is a spelling, not a different currency.
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  footerText: z.string().max(200).optional(),
  showPageNumbers: z.boolean(),
});
export type DocumentStyle = z.infer<typeof documentStyleSchema>;

export const DOCUMENT_STYLE_DEFAULTS: DocumentStyle = {
  font: "sans",
  baseFontSize: 10,
  accentColor: "#111827",
  margin: "normal",
  pageSize: "A4",
  locale: "pt-BR",
  currency: "BRL",
  showPageNumbers: false,
};

// PER KEY, not per object, and that is the whole difference. `.partial().safeParse` fails wholesale:
// one property this version cannot read — a font family or a margin name a NEWER build wrote — and
// the result was every setting replaced by its default. The console then saved those defaults back
// over the stored style, so a patch of one property reset the other eight while reporting success.
//
// Reading key by key keeps everything this version does understand and defaults only what it does
// not, which is the same tolerance storage already promises for a block it cannot parse.
export function parseDocumentStyle(value: unknown): DocumentStyle {
  const raw = (value ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...DOCUMENT_STYLE_DEFAULTS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, schema] of Object.entries(documentStyleSchema.shape)) {
      if (!(key in raw)) continue;
      const parsed = (schema as z.ZodType).safeParse(raw[key]);
      if (parsed.success) merged[key] = parsed.data;
    }
  }
  const style = merged as unknown as DocumentStyle;
  return {
    ...style,
    currency: style.currency.toUpperCase(),
    baseFontSize: Math.min(
      BASE_FONT_SIZE_MAX,
      Math.max(BASE_FONT_SIZE_MIN, Math.round(style.baseFontSize)),
    ),
  };
}

// Whether a block can EVER put something on the page, from the template alone.
//
// Deliberately only the unconditional half. Whether a given document draws depends on the values
// that arrive at the turn — an optional field, a logo the tenant has not uploaded, a discount of
// zero — and that question is answered exactly, with those values in hand, by documentDraws in
// draws.ts. Trying to answer it here means guessing, and a guess either refuses a template that is
// perfectly fine for the tenant that wrote it or misses the case anyway.
//
// What is left is what no value can rescue: a divider draws a rule and nothing else, and a text
// block with no text has nothing to resolve. An error at the keyboard beats a surprise at the turn,
// which is the only reason this exists beside the exact check.
export function blockCanDraw(block: DocumentBlock): boolean {
  switch (block.type) {
    case "divider":
      return false;
    case "text":
      return block.text.trim() !== "";
    case "header":
      // A header has five sources of content and two of them are value questions: a logo the tenant
      // may or may not have uploaded, and a company profile they may or may not have filled in. Both
      // are left to `documentDraws`, which asks them with the values in hand.
      //
      // What is unconditional is switching those two OFF. `showLogo === false` and
      // `showCompany === false` are read as `!== false` by the renderer, so an explicit false is the
      // only way to reach "the logo and the profile are not on this page" from the template alone —
      // and with a title, a subtitle and the meta rows all absent, nothing is left for any value to
      // rescue. Trimmed, because the renderer draws no glyph for whitespace.
      if (block.showLogo !== false || block.showCompany !== false) return true;
      return Boolean(
        block.title?.trim() || block.subtitle?.trim() || block.meta?.length,
      );
    default:
      return true;
  }
}

// ── bounds ──

// The preview renders on the request thread with operator-supplied input, which makes it the one
// place a tenant can spend our CPU on a shape they chose. Both ceilings are checked BEFORE the
// render, never during it.
export const MAX_BLOCKS_PER_DOCUMENT = 60;
export const MAX_LINE_ITEMS = 100;
// The declared fields BECOME the agent's tool schema, and that schema is published on every turn of
// every agent granted the template. Unbounded, one write makes every turn carry a payload the
// provider may refuse outright — so this ceiling is not about our own memory, it is about what the
// model is handed. Well above any real document: the bundled starters declare four to six.
export const MAX_FIELDS_PER_DOCUMENT = 40;

// The largest amount a document may carry, per value AND per line. `Number.isFinite` is not enough:
// a unit price of 1e308 passes it, and the integer-cent arithmetic then produces Infinity — a
// numbered PDF whose total reads "∞", or worse, a number that is merely wrong.
//
// Derived, not picked: cents must stay exact, so the accumulated total has to stay a safe integer.
// MAX_SAFE_INTEGER is ~9.007e15 cents; MAX_LINE_ITEMS (100) lines of this cap sum to 1e13 cents,
// two orders of magnitude inside it, with the discount and tax rows fitting the same way. And it is
// a hundred billion — no real document approaches it, so nothing legitimate is refused.
export const MAX_DOCUMENT_AMOUNT = 1e11;

// Token OCCURRENCES across a whole template, counted with repeats. The input bounds do not bound the
// output: a 5,000-character text block may hold a thousand `{{x}}`, each one resolving to a value of
// up to 2,000 characters, so one block expands to ~2 MB and sixty of them to more than 100 MB —
// built on the request thread, before markdown parsing and PDF layout, by any authenticated tenant.
// The ceiling is on the amplifier rather than on the result, because the amplifier is the half that
// is known when the template is WRITTEN, and a template is written once while it renders forever.
// A hundred is far past any real document: the bundled starters use six.
export const MAX_TOKENS_PER_DOCUMENT = 100;

// The authoring contract, generated FROM the schemas above so it cannot drift from what the
// validator enforces. Served on demand (the `document_template_schema` MCP tool, and the console's
// block reference) rather than published in every tools/list: a six-variant discriminated union
// costs thousands of characters of JSON Schema on every session, and only the caller actually
// authoring a template needs it.
export function documentAuthoringSchema(): Record<string, unknown> {
  return {
    blocks: closed(z.toJSONSchema(documentBlockSchema)),
    fields: closed(z.toJSONSchema(documentFieldSchema)),
    // PARTIAL, because that is what a write accepts: create fills the defaults for what is missing
    // and update keeps the stored value, so `{"font":"serif"}` is a supported payload. Publishing
    // the strict object marks every property required, and a client validating against the contract
    // refuses a style the server would have taken.
    style: closed(z.toJSONSchema(documentStyleSchema.partial())),
  };
}

// The published contract has to say what the WRITE actually enforces. Zod's own schemas strip an
// unknown key (right for reading a stored row, see validate.ts), but a write refuses it by name — so
// a schema published without this would promise a permissiveness no write honours, and a client
// would be told its property is unsupported by a document it had every reason to trust.
//
// Derived by walking the generated schema rather than by keeping a second set of Zod objects: there
// is one vocabulary, and a copy of it is a copy that goes stale.
function closed(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closed);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = closed(v);
  }
  if ("properties" in out) out.additionalProperties = false;
  return out;
}
