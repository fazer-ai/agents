# Documents: templates, issuance, delivery

The operator defines a **document template** — a quote, a proposal, a receipt, a service order — and
the agent **issues one from inside the conversation and attaches it to its reply**. A document is a
PDF the customer keeps, so everything here is built around the three properties that follow from
that: it must be right, it must not change after it is sent, and it must not be sent by accident.

This replaces the `quotes` subsystem, which rendered a PDF and had no way to author one, no way for
an agent to produce one, and no way to hand one to a customer.

## The pieces

| | |
| --- | --- |
| `DocumentTemplate` | blocks (the layout), fields (what the agent fills), style, numbering |
| `IssuedDocument` | one rendered document: its number, its frozen snapshot, its PDF |
| company profile | the letterhead, in `Tenant.settings.company` + a logo on disk |
| the agent's tool | one per granted template, named `send_<slug>` |

## Blocks

A document is an ordered list of blocks, from a **closed** vocabulary
(`src/modules/documents/blocks.ts`): `header`, `text`, `fields`, `lineItems`, `totals`, `divider`.
Every block carries an `id` (so the console can edit one across a reorder made from the API) and an
optional `spaceAfter`.

The set is closed because every block is something the renderer knows how to lay out. What it does
not cover goes into a `text` block as prose — that is the escape hatch, and it is why there is no
`html` or `raw` block. `text` understands a small markdown: `**bold**`, `*italic*` / `_italic_`,
`- ` bullets, and nothing else. Anything richer renders as its own source, which is deliberate:
a construct the parser half-understands produces layout nobody authored, in a document a customer
keeps.

`totals` computes its own arithmetic from the line items, in integer cents. A model is never asked
for a sum: it will eventually get one wrong in front of a customer, and the number it got wrong is a
price. A discount larger than the subtotal is clamped, and the CLAMPED value is what is printed — so
the three numbers on the page always add up to each other.

## Fields and tokens

`fields` is the contract: `{name, label, type, required?, description?}` with
`text | number | date | currency | lineItems`. It is what makes "custom fields the agent fills"
real — the declared fields become the **argument list of the tool the agent gets**, so the operator
writes the contract once and the model sees exactly it.

Any text in a block may carry `{{tokens}}`:

| namespace | tokens |
| --- | --- |
| company | `company_name`, `company_document`, `company_address`, `company_phone`, `company_email`, `company_website` |
| document | `doc_number`, `doc_date`, `doc_title` |
| fields | any declared field, by its own name |

Each reserved token has a pt-BR alias (`empresa_nome`, `documento_numero`, …) that resolves to the
same value. A field name may not start with `company_`, `empresa_`, `doc_` or `documento_`, and a
token naming neither a declared field nor a reserved name is **refused when the template is
written** — because downstream it is a blank space in a PDF the customer keeps and nothing reports
it.

This is a sibling of the system prompt's placeholder machinery, deliberately not the same code.
`PROMPT_PLACEHOLDER_SOURCE` is a shared contract (the prompt editor's highlighter, the cache warning,
the prompt audit), an unresolved prompt placeholder is left LITERAL, and `sanitizePromptValue`
collapses every run of whitespace — right for one line of a prompt, wrong for a "payment terms" field
that is legitimately several lines.

## Style

`font` (`sans`/`serif`/`mono`), `baseFontSize`, `accentColor`, `margin`, `pageSize`, `locale`,
`currency`, `footerText`, `showPageNumbers`.

The three families are `@react-pdf/renderer`'s built-ins. There is no `Font.register` and no bundled
TTF: a face resolves from a path that differs between the dev tree and the container, the registry it
goes into is global and does not deduplicate, and the built-ins cover Latin-1, which is what PT-BR
needs. A bundled family is purely additive later.

The console owns the **words**, and it sends them as `blockText` — the text of `text` blocks by ID,
merged server-side into the layout as it stands. It never sends the `blocks` array back: doing that
would make the console authoritative over a layout it did not author, so a block added or reordered
over the API while the modal was open would be silently replaced by the snapshot the modal loaded.
Block ids exist for exactly this.

### Authoring is strict; storage is tolerant

Two questions, deliberately answered differently. Reading a **stored** row is tolerant: a template
written by a newer build must keep rendering, so a property this version does not know is dropped
rather than fatal, and an unusable style falls back to defaults instead of taking the console down.
Reading an **authored** template is strict: what the operator wrote either takes effect or comes back
refused by name. Every write goes through the strict gate — console, REST, MCP, and an imported
bundle, which is authored content arriving from outside.

Without that split the transport's permissiveness buys nothing: the whole reason the route accepts an
undeclared shape (`t.Record`, see below) is so the **service** can say what is wrong with it, and a
schema that silently strips `alignn` saves a template that differs from the one that was submitted
with nothing anywhere reporting it. The strict pass compares what came back against what was given
rather than keeping a second copy of every schema — one vocabulary, and a copy of it goes stale — and
`document_template_schema` publishes `additionalProperties: false` so the contract a client authors
against says what the write enforces.

The strict pass applies to the halves the **caller wrote**, never to what came out of storage. An
update that only changes the wording is validated against the stored blocks but does not re-author
them, and the columns it does not address are not rewritten — otherwise the tolerant read (which
drops what this version does not know) would be written back, and an ordinary console save would
permanently delete layout a newer build wrote. A stored block whose TYPE this version cannot read at
all cannot be saved around, so that save is refused and says why.

Sizes stay clamped rather than refused (`baseFontSize`), because a clamp changes a value and never a
key: "type and choice, never size" (`docs/mcp.md`).

`footerText` goes through the **same token resolver** the block texts do, and it prints on every
page, so its tokens are validated with them: a template is refused as a whole, style included. That
is also why a patch touching only the style is re-validated — the names a footer may use are declared
in the half the patch did not send.

## Issuing

`issueDocument` is one core with two callers (`POST /v1/documents` and the agent's tool), two-phase
and idempotent:

1. **The idempotency key is checked first**, before the template is even read (and before that, the
   key itself is checked for what the `text` column refuses — it is the first value bound, so a NUL
   in it would answer a caller with a 500 from the lookup instead of a refusal they can act on). The key means the
   document already exists and its content was frozen when it was issued — validating the caller's
   values against the template as it stands *today* would make a retry fail the moment the template
   changed.
2. Otherwise: load the template, validate the values, freeze a **snapshot** (blocks, fields, style,
   company profile and values as resolved), insert the PENDING row, take a number. "As resolved" is
   literal and load-bearing: every string in the snapshot is the SANITISED one, so what is frozen is
   what the renderer will print. It is also what the column will accept — the snapshot is `jsonb`,
   where an unpaired surrogate is refused outright, so a raw value stored beside a sanitised check
   fails the issuance rather than printing oddly.
3. Render the STORED snapshot outside any transaction, write it to a path derived from numeric ids,
   CAS to READY.

Steps 2 and 3 are separate scoped calls rather than one transaction, and the insert is on its own:
a `P2002` **aborts the PostgreSQL transaction it was raised in**, so the re-read that recovers the
winner of an idempotency race cannot happen inside the transaction that lost it. Catching the
conflict and re-reading in the same one turns a benign race — the very thing the key exists to make
benign — into `current transaction is aborted` and a 500 for whoever arrived second.

The number comes from `UPDATE document_templates SET last_number = last_number + 1 … RETURNING`, so
the row lock makes it atomic. It is bumped AFTER the insert, so losing a race on the key does not
consume one. Monotonic, not gapless.

That last property is also why the **document row is claimed first**, with `SELECT … FOR UPDATE`,
before the counter is touched: a row exists unnumbered for a moment by design, and in that window a
second caller re-reads it, sees no number and heals it at the same time as the first. Unclaimed, both
take a number, one update is discarded, and the caller that lost renders a document with **no number
at all** over the winner's PDF — the customer's link then serves a quote with a blank where its
identity should be.

**Revocation ends the document, including through the key.** The idempotency key is derived from the
values, so an agent asked to send the same quote again lands on the row the operator voided; the
retry path refuses it (409) rather than handing back the stored bytes, which is the answer the
download route already gives, decided at a different stage.

The **date is resolved in the issuing agent's timezone** and frozen with the snapshot. Slicing the
calendar day off the UTC instant is wrong for every tenant that is not on UTC: a document issued at
22:00 in São Paulo is 01:00 UTC the next day, and the customer would receive a quote dated tomorrow.
The REST route, which has no agent, falls back to the fleet default zone.

The template's **number prefix is frozen onto the issued row**, not joined when the number is
printed. The number is how a document identifies itself to the customer holding it: renaming the
template's prefix must not rewrite numbers already in circulation, and deleting the template (which
nulls the FK, by design, because the documents outlive it) must not erase them.

**Rounding is done on the DECIMAL, not on a binary product.** `Math.round(v * 100)` reads 1.005 as
100.49999999999999 and rounds it down to `R$ 1,00`, while the renderer prints `R$ 1,01` — the same
contradiction the cent arithmetic exists to remove, one layer further down. Shifting through the
value's string form (`` `${v}e2` ``) is what matches, verified against `Intl` over 200,000 values
across nine magnitudes, positive and negative, with zero mismatches.

**What the document prints is what it computed with.** The factors are quantized to the precision
the renderer shows them at — money at two decimals, quantity at four — before they are multiplied, so
a unit price of 0.105 that prints as `R$ 0,11` multiplies as `0,11`. Otherwise the customer holds
three numbers (`3`, `R$ 0,11`, `R$ 0,32`) that do not agree, which is exactly the discrepancy the
integer-cent arithmetic exists to prevent, one level below where it was being applied. A lone amount
needs no such step: converting to cents IS the money quantization.

## Delivery

A document tool **issues and queues in one call**: issuing and sending are one act from the
customer's side, and splitting them would cost a model round-trip and open a window where a numbered
document exists and nobody was told.

Delivery itself happens in the runtime, after the same gates the reply passes (ownership recheck,
supersede gate, output guardrail), ahead of the reply text — the shared `TurnState.pendingAttachments`
queue that `send_image` also uses. One queue, because the gates a file has to pass to reach a
customer are a property of the TURN, not of what the file is. Each entry carries the **tool** that
queued it (for the flow line) and its **kind** (for the quota): reading one field for both questions
is how a document would land in the image budget.

The **output guardrail sees what the model wrote on the document**, not only the reply and the
captions: a field value and a line-item description are model-written text the customer reads, and
they reach them as a numbered PDF they keep. Operator-authored block text is not screened — that
would be moderating the operator, not the model. A trip drops the whole queue, so a document whose
values violate is never sent.

Revocation is asked again **immediately before the send**. The tool queues bytes, and the model
still has a response to finish: an operator watching the conversation can revoke in that window, and
bytes cannot say they were voided. The queue entry carries the document's identity so the row can be
asked.

A document that was issued and then not delivered — a turn taken over, superseded, or blocked — is
**left as it is**, not revoked. The idempotency key is derived from the values, so the next turn's
identical call returns that same row and delivers it; revoking would turn a recoverable state into a
permanent refusal. The cost is that "Recently issued" lists a document nobody received yet, which is
a reporting gap and not a delivery one, and the operator can send it by hand.

**The key carries the calendar day**, so that recovery is bounded. Without it the key never expires:
a customer coming back weeks later and asking for the same thing, with the same values, was answered
with the frozen document — its old number, its old date, and a validity that may already have run
out. A retry is what the key covers, and a day is a generous window for one. The day is the same one
the document prints, resolved in the agent's timezone, so a reused document is one dated the day it
is being sent.

At most one document per turn, and the slot is **reserved before the await**, the way `send_image`
reserves a download. One model response's tool calls run under `Promise.all`, so a check that only
reads the queue is read by every call in the batch while the queue is still empty: all of them pass,
all of them issue a numbered document, and all but one is discarded — leaving documents on the
tenant's list that were never sent and that nobody can account for. The reservation is released in a
`finally`, so a refused call does not burn the turn: the model is told what to fix and its corrected
call arrives in the same turn, by which point the queue carries the claim instead.

## Granting

`AgentToolSelection` with `source = DOCUMENT` and a `documentTemplateId`. **Fail-closed**, like
HTTP/MCP/integration/RAG and unlike NATIVE: an agent with no grant has no document tool, so no
existing agent gains one on upgrade.

The tool's name is `send_<slug>`, and the slug is **derived from the template's name and stays
derived while a name is being typed**. The console re-derives it on every keystroke in the name
field, so renaming a template renames its tool: a template called "Contrato de prestação" behind a
tool called `send_orcamento` is a thing the operator cannot see from the conversation and cannot
explain from the console. The slug field is editable, and a slug typed by hand is overwritten by the
next edit to the name — the name is the source, and a slug that outlived it would be a second name to
keep in sync by hand.

Renaming the tool has one cost worth knowing: the persisted conversation history holds the tool calls
the agent already made, under the OLD name, and those travel to the provider on later turns until the
history window slides past them. Whether any provider rejects a transcript naming a tool absent from
the current list has not been measured.

Both ends apply the same rules, from `modules/documents/slug.ts` — `slugifyTemplateName`,
`slugProblem`, `documentToolName` — imported rather than restated, so the console cannot preview a
tool name the write would not produce.

Two consequences, and they pull in opposite directions.

**Names are unique per account**, and that is not bookkeeping: the name is what the model reads to
choose between document tools. Two templates called "Orçamento" would publish two tools with the
same description and nothing to pick between them, so the agent sends whichever it happens to choose
and the customer gets the wrong document. Numbering the second one (`send_orcamento_2`) hides exactly
that until it reaches a customer, so the write refuses instead — in terms of the **name**, which is
what the operator typed, naming the template that already holds it. The console asks for the name at
creation for the same reason, prefilled from the starter.

The constraint is its **own** unique index, `(tenant_id, name)`, separate from the slug's. Deriving
uniqueness from the slug looks equivalent and is not: a caller can supply its own `slug`, and a
write that carries only a name never derives one, so both roads reach two templates with one name. All four write
paths are fenced — create, rename, the MCP dry run, and the bundle import, which **skips** a template
whose name the destination already holds (`documentTemplateNameTaken`) rather than reusing it, since
the grant resolves by slug and binding it to another template would hand the agent a tool the bundle
never asked for.

**But a derivation that cannot produce a usable identifier is a different thing**: a wall in front of
an ordinary name, about something the operator did not choose. "2026 Orçamento"
derived `2026_orcamento`, which a tool name may not start with, so `slugifyTemplateName` prefixes
`doc_` rather than stripping the digits (dropping them makes "2026" and "2027" the same slug). What
remains is a name that normalises onto a **built-in** tool — "Image" produces `send_image` — and that
one is refused, again by name, because there is no identifier to repair. That check cannot be complete on its own: an MCP server names its own tools when it is
contacted, so "is this name still free?" is a question no write can finish answering. The assembly is
the one place that sees every name at once, so `dropDuplicateToolNames` decides it there — earlier
wins, which puts the built-ins first, the loser is dropped rather than fatal (one bad name must not
take a whole agent down), and the names that lost are logged for the operator who can rename them.

## Transports

- **Console** — Components → Document templates. Create from a ready-made starter (quote, proposal,
  receipt), edit the letterhead, edit the **wording** of `text` blocks, and watch a live PDF preview.
  Adding, removing and reordering blocks is API/MCP only. The panel is split in two: **Templates**
  (the letterhead as a one-line summary that opens an editor, then the templates) and **Issued** (the
  documents that went out, with the template each came from — and the only place a document can be
  revoked). The same modal opens
  from the **agent's Tools tab**, on the document card being granted: it is the one grant whose target
  has a picture, and "what does this print?" is the question being answered at that moment.
- **REST** — `/v1/document-templates` (CRUD, `POST /preview`, `/starters`), `/v1/documents` (issue,
  list, PDF, revoke), `/v1/tenant-settings/company` (+ `/logo`).
- **MCP** — `document_template_list/get/create/update/delete`, `document_template_schema`,
  `document_starters_list`, `issued_document_list`. `document_template_schema` serves the block
  vocabulary as JSON Schema generated from the validator; see `docs/mcp.md` for why it is not
  published in every `tools/list`.

`{{tokens}}` are capped per document (counting repeats), because the input bounds do not bound the
OUTPUT: a 5,000-character block may hold a thousand of them, each resolving to a value of up to 2,000
characters, and sixty such blocks build more than 100 MB on the request thread before layout. The cap
is on the amplifier rather than on the result, because the amplifier is the half that is known when
the template is written.

The preview renders an **unsaved draft**, which is what makes authoring through the API bearable:
build the blocks from a script or an MCP client, then look at the document. The MCP dry-run renders
too, so a `document_template_create` that would not lay out fails before it saves.

## Storage

`DOCUMENTS_STORAGE_DIR` holds `<tenantId>/documents/<documentId>.pdf` and
`company/<tenantId>-logo.<ext>`. `QUOTES_STORAGE_DIR` is still read as a fallback, and that is not
tidiness: platforms that freeze a compose value at install time (Coolify) never hand an existing
installation the new name, and without the fallback that installation writes inside the container and
loses every PDF on the next redeploy.

That fallback is also why the `documents/` segment is not decoration. An upgraded installation points
this directory at the one the quotes subsystem used, which already holds `<tenantId>/<quoteId>.pdf`,
and `issued_documents` is a new table whose ids start over. Sharing the layout would put a new
document on an old quote's file name, where `link` answers EEXIST, the publisher reads that as "another
renderer got here first", and the row goes READY over a stranger's document — which is then what the
download serves and what the agent attaches.

The filesystem has no RLS, so the **scoped read of the row** is the boundary: a storage key is only
resolvable for the owning tenant, and every refusal is a 404 — which of the reasons applies is
information about a document the caller may not be entitled to know exists.

The logo's file name is derived from the tenant id and the extension, so replacing a PNG with another
PNG lands on the same name. A `logoVersion` on the company block moves on every write, and that is
what the console keys its fetch off: the name alone cannot say the letterhead changed, so a same
format replacement would leave the card — and any browser cache of a response served with a
`max-age` — showing the old logo while issued documents already carry the new one.

The upload is bounded by **pixels**, not only by bytes: both formats compress flat colour
enormously, so a 40 KB file can declare 20000×20000 and the renderer — which decodes server-side, on
every preview and every issuance, in a process every tenant shares — would allocate gigabytes for it.
The dimensions are read from the header (PNG's IHDR, JPEG's first SOFn) and refused above four
megapixels; an image whose dimensions cannot be read is refused too, because unmeasurable is
unbounded. The JPEG walk skips **fill bytes** — any marker may be preceded by any number of `0xFF`
(ITU T.81 B.1.1.2) — because reading one as a marker turns the bytes after it into a segment length
and steps the walk off the file, and the operator then sees a standards-valid logo refused as too
large.

The upload's **bytes decide the format**, not the label on them: `file.type` is whatever the caller
put in the multipart part (and Bun derives it from the file name's extension, which a REST caller
controls outright), so a JPEG announced as a PNG would be stored under a `.png` key and then fail
every preview and every issuance of a template showing the logo. The signature is checked before
anything is written.

The logo is read from disk as **bytes** and never as a URL: `@react-pdf/renderer` will fetch an
`<Image src>` over the network, which on a server renderer is a request driven by tenant input. Its
allowlist is narrower than branding's (PNG/JPEG only) because the PDF renderer decodes fewer formats
than a browser, and an SVG would feed an XML parser inside the renderer for no benefit.
