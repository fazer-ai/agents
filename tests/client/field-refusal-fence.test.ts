import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codeSkeleton } from "@/tests/client/error-toast-reason.test";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// THE GUARD AGAINST THE NEXT FORM THAT SENDS A FIELD REFUSAL TO A BANNER.
//
// #231 put the refused field on the wire, #232 built the state that renders it at the control, and
// this sweep wired the console. What comes back without a guard is the form written next week: it
// will read the server's sentence (the other fence in this directory sees to that) and drop it into
// a toast or an error line, which is far from the input and, on a long form, leaves the operator
// counting down the fields to work out which one the server meant.
//
// Two rules, because a form can fail this in two directions and only one of them is visible:
//
//   1. a form that WRITES holds its refusal — `useFieldRefusal`, or a named reason not to;
//   2. every name a form DECLARES is read back by an `at(…)` call in the same file. A declared name
//      with no control behind it is worse than not declaring it: `placeRefusal` marks it as placed
//      and the caller then keeps the toast silent, so the refusal reaches nobody at all. Measured
//      while wiring ToolEditModal, which declared `allowedHosts` and renders no such input.

const ROOT = "src/client";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

// A control the operator types or picks into. The pickers are named too: a credential or a business
// hours selection is refused by the server like any other value.
const RENDERS_A_CONTROL =
  /<(?:FormField|Input|Textarea|Select|CredentialPicker)\b/;

// A WRITE, and only a write. `POST` is also how this API asks two questions whose answer is a list
// (the model catalog, the voice catalog) and how it runs a connection test — none of those carry a
// form's values, so none of them can refuse one.
const WRITES = /\.(?:post|put|patch)\s*\(/;
const NOT_A_WRITE = /\b(?:list|preview|test|extract|transcribe|discover)\b/;

export function writesAForm(src: string): boolean {
  return RENDERS_A_CONTROL.test(src) && writeHandlers(src).length > 0;
}

// One function of a component, by name. Both spellings this tree uses — `async function save()` and
// `const submit = async () => {` — at the component's own indentation, so a callback nested inside
// one is part of its body rather than a handler of its own.
//
// Named and not merely located, because the whole point is to say WHICH handler is unheld: a file
// with six forms is not answered by "this file calls the hook somewhere", which is what the previous
// version of this fence asked and what let `useKnowledgeManager`'s add-text form through with a
// holder that was read and never written.
const HANDLER_HEAD =
  /\n {2}(?:export )?(?:async function (\w+)|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>|function (\w+))/g;

export function handlers(src: string): {
  name: string;
  body: string;
  // The same span with comments and string CONTENTS blanked out, offsets preserved. Every question
  // this file asks of a handler is about what it runs, and prose is where those words appear
  // innocently: `useKnowledgeManager`'s reindex button sends no body at all, and read raw it looked
  // like a form write because a comment inside it says "Same text as the banner".
  code: string;
}[] {
  // Bounded by its own closing brace, not by where the next handler starts. Slicing to the next head
  // makes the LAST handler of a nested component swallow everything after it, and this file's whole
  // subject is per-handler attribution: measured, that made `ChannelsPage`'s `select` — which awaits
  // a callback and no request at all — read as a write of the function three declarations below it.
  const code = codeSkeleton(src);
  return [...src.matchAll(HANDLER_HEAD)].map((m) => {
    const open = code.indexOf("{", m.index + (m[0] as string).length - 3);
    let depth = 0;
    let end = src.length;
    for (let i = open; i >= 0 && i < code.length; i++) {
      const c = code[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    return {
      name: (m[1] ?? m[2] ?? m[3]) as string,
      body: src.slice(m.index, end),
      code: code.slice(m.index, end),
    };
  });
}

// The handlers that write a form's values back. `POST` is also how this API asks two questions whose
// answer is a list (the model catalog, the voice catalog) and how it runs a connection test — none of
// those carry a form's values, so none of them can refuse one.
export function writeHandlers(src: string): string[] {
  return handlers(src)
    .filter((h) => writes(h.code))
    .map((h) => h.name);
}

function writes(code: string): boolean {
  return code
    .split("\n")
    .some((line) => WRITES.test(line) && !NOT_A_WRITE.test(line));
}

// The names that carry a capture, directly or through another name. A form with two failure branches
// writes one helper and calls it twice — `const held = (e, sent) => refusal.capture(…)` — and the
// helper lives at component scope, outside every handler body.
function capturingNames(code: string): Set<string> {
  const names = new Set<string>();
  for (;;) {
    const before = names.size;
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=([^;]*)/g)) {
      const name = m[1] as string;
      const rhs = m[2] as string;
      if (names.has(name)) continue;
      if (
        /\.capture\(/.test(rhs) ||
        [...names].some((r) => new RegExp(`\\b${r}\\s*\\(`).test(rhs))
      ) {
        names.add(name);
      }
    }
    if (names.size === before) return names;
  }
}

// A write handler that sends a value this form DECLARED and does not route its failure through a
// refusal holder.
//
// Declared is what bounds it, and the bound is the rule rather than a convenience: the fence's whole
// subject is "a refusal naming an input this form renders reaches that input", so a handler that
// sends nothing the form named cannot receive one. That is what separates a submit from the actions
// beside it — `revoke.post()` carries no body at all, `toggleEnabled` sends the one switch of a list
// row, `saveGuardrails` sends the settings bag whose paths this page deliberately does not declare
// (see PARTIALLY_HELD). Asking every write instead flagged twenty-five handlers, of which one was a
// form.
export function unheldWrites(src: string): string[] {
  if (!RENDERS_A_CONTROL.test(src)) return [];
  const declared = declaredFields(src);
  if (declared.length === 0) return [];
  const sends = new RegExp(
    `\\b(?:${declared.map((f) => f.split(".").pop()).join("|")})\\b`,
  );
  const carriers = capturingNames(codeSkeleton(src));
  return handlers(src)
    .filter((h) => {
      if (!writes(h.code) || !sends.test(h.code)) return false;
      if (/\.capture\(/.test(h.code)) return false;
      return ![...carriers].some((n) =>
        new RegExp(`\\b${n}\\s*\\(`).test(h.code),
      );
    })
    .map((h) => h.name);
}

// A BRANCH of a held handler that writes the form's error line without going through the holder.
//
// `unheldWrites` asks per handler, and a handler is answered by one `capture` anywhere inside it —
// which is exactly how `AlertChannelsSection` passed while its `catch` wrote a fixed sentence
// straight into the modal-local banner. The resolved-error branch was wired; the thrown one was not,
// and Eden REJECTS on a transport failure, so the unwired branch is the one the operator hits when
// the network is what failed. Dismiss the dialog during that and the sentence reaches nobody.
//
// Only branches AFTER the request went out, and only ones that write a SENTENCE.
//
// Both bounds are the rule, not convenience. A `setError` before the write is a pre-submit guard —
// "Passwords do not match", "Headers must be valid JSON." — which the client decided on its own and
// which no server was asked about; routing one through `capture` would be nonsense, and so would
// routing the `setError("")` that clears the line at the top of a submit.
export function unheldBranches(src: string): string[] {
  const carriers = capturingNames(codeSkeleton(src));
  if (carriers.size === 0) return [];
  const out: string[] = [];
  for (const h of handlers(src)) {
    const uses = [...carriers].some((n) =>
      new RegExp(`\\b${n}\\s*\\(`).test(h.code),
    );
    if (!uses && !/\.capture\(/.test(h.code)) continue;
    const sent = sentAt(h.code);
    if (sent < 0) continue;
    for (const m of h.body.matchAll(
      /\bset(?:[A-Z]\w*)?Err(?:or)?\(([^;]*?)\)[;,\n]/g,
    )) {
      if ((m.index as number) < sent) continue;
      const arg = (m[1] as string).trim();
      if (/^(?:""|''|``|null|undefined)$/.test(arg)) continue;
      if (/\.capture\(/.test(arg)) continue;
      if ([...carriers].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(arg)))
        continue;
      out.push(`${h.name} :: ${arg.split("\n")[0]}`);
    }
  }
  return out;
}

// Where the handler stops deciding for itself and starts answering the server: the offset of its
// first write call.
function sentAt(code: string): number {
  let at = 0;
  for (const line of code.split("\n")) {
    if (WRITES.test(line) && !NOT_A_WRITE.test(line)) return at;
    at += line.length + 1;
  }
  return -1;
}

// A caller that does not believe the hook's null.
//
// `capture` answers one question — is there anything left for YOU to say — and null is "no": the
// sentence is on the control, or the form had left the screen and the hook raised the global toast
// itself. Substituting a fallback for that null fires the second channel on top of the first, and
// the two spellings of the mistake are the same operator experience: a message under the box AND a
// toast repeating it, or two identical toasts. Measured on `CompanyProfileCard`, whose catch read
// `toast ?? t("…saveError")`.
export function distrustedNulls(src: string): string[] {
  const code = codeSkeleton(src);
  const carriers = capturingNames(code);
  const ends: number[] = [];
  for (const m of code.matchAll(/\.capture\(/g)) {
    const open = (m.index as number) + ".capture".length;
    ends.push(open + argumentOf(code, open).length + 2);
  }
  for (const n of carriers) {
    for (const m of code.matchAll(new RegExp(`\\b${n}\\b`, "g"))) {
      const after = (m.index as number) + n.length;
      ends.push(
        code[after] === "("
          ? after + argumentOf(code, after).length + 2
          : after,
      );
    }
  }
  const out: string[] = [];
  for (const end of ends) {
    const rest = code.slice(end);
    const op = rest.match(/^\s*(\?\?|\|\|)\s*/);
    if (!op) continue;
    const at = end + (op[0] as string).length;
    const width = (code.slice(at).split(/[,;)]/)[0] ?? "").length;
    // Read from the SOURCE and not the skeleton, because the operand is the words themselves and the
    // skeleton is exactly what blanks them out.
    const right = src.slice(at, at + width);
    // `?? ""` is a TYPE coercion, not a second sentence: the state it feeds is `string`, and an
    // empty one renders nothing. What this rule is about is a caller answering the hook's "they have
    // already been told" with words of its own.
    if (/^\s*(?:""|''|``|null|undefined)\s*$/.test(right)) continue;
    out.push(`${op[1]} ${right.trim().slice(0, 40)}`);
  }
  return [...new Set(out)];
}

// A staleness check that compares a value with itself.
//
// `capture` takes what the request CARRIED and what the inputs hold NOW, and refuses to mark a
// control that has moved on. Handing it the same expression twice makes that comparison a tautology
// — always "unchanged", always placed — while the render reads the live value and finds no mark for
// it. The refusal then reaches neither channel. Measured on `ChannelsPage`'s account picker, whose
// rows stay live while the PUT is out.
export function tautologicalStaleness(src: string): string[] {
  const code = codeSkeleton(src);
  const out: string[] = [];
  for (const m of code.matchAll(/\.capture\(/g)) {
    const args = splitArgs(
      argumentOf(code, (m.index as number) + ".capture".length),
    );
    if (args.length < 4) continue;
    const [, , sent, current] = args as [string, string, string, string];
    if (sent.trim() && sent.trim() === current.trim()) out.push(sent.trim());
  }
  return out;
}

// A call's arguments, split on the commas that belong to IT.
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(last, i));
      last = i + 1;
    }
  }
  out.push(args.slice(last));
  return out
    .map((a) => a.trim())
    .filter((a, i, all) => a || i < all.length - 1);
}

// A holder that is declared and then half-used. Either half alone is silence: a holder nobody
// captures into can only ever answer null at every `at(…)` reading it, and a holder nobody reads
// keeps the toast quiet about a refusal it has placed nowhere.
// A holder can also be used through a REGISTER: the agent editor keeps one per writing form (#415)
// and reaches them as `refusals[section].capture(...)`, so no holder is ever named at a call site.
// The obligation is unchanged and so is its force, since a holder that is declared and left out of
// the register is exactly the orphan this flags, but the proof moves: the register is what has to be
// captured and read, and each holder has to be IN it.
//
// Deliberately keyed off the `Record<_, FieldRefusal>` annotation rather than any object that
// mentions a holder. An unannotated bag would let a file opt out of this check by listing its
// holders somewhere, which is the same hole as not checking at all.
function registeredHolders(src: string): {
  register: string | null;
  members: Set<string>;
} {
  const m = /const (\w+): Record<[^,]+, FieldRefusal> = \{/.exec(src);
  if (!m) return { register: null, members: new Set() };
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return { register: null, members: new Set() };
  const body = src.slice(open + 1, close);
  const members = new Set<string>();
  for (const entry of body.matchAll(/[\w"']+\s*:\s*(\w+)\s*,/g)) {
    members.add(entry[1] as string);
  }
  return { register: m[1] as string, members };
}

export function halfUsedHolders(src: string): string[] {
  const out: string[] = [];
  const { register, members } = registeredHolders(src);
  // The register itself answers for its members, so it has to be whole on both sides. Read through
  // any name, because the aggregator that consults every holder is not the register variable.
  const registerCaptures =
    !!register &&
    new RegExp(`\\b${register}\\[[^\\]]+\\]\\??\\.capture\\(`).test(src);
  // `.at\b` rather than `.at(`: a page with several holders reads them through an aggregate, and
  // the natural spelling passes the method as a REFERENCE (`refusals[s].at`) instead of calling it
  // there. Requiring the call site would have forced a worse shape to satisfy the guard.
  const registerReads =
    !!register &&
    new RegExp(`\\b${register}\\[[^\\]]+\\]\\??\\.at\\b`).test(src);
  for (const m of src.matchAll(/const (\w+) = useFieldRefusal\(/g)) {
    const name = m[1] as string;
    const viaRegister = members.has(name);
    const captures = viaRegister
      ? registerCaptures
      : new RegExp(`\\b${name}\\.capture\\(`).test(src);
    const reads = viaRegister
      ? registerReads
      : new RegExp(`\\b${name}\\.at\\(`).test(src);
    if (!captures || !reads)
      out.push(`${name} (${captures ? "never read" : "never captured"})`);
  }
  return out;
}

// EVERY holder in the file with the names it declares, not the first one that happens to appear.
//
// A file with one form is the easy case and it is not the common one here: `ChannelsPage` keeps
// three holders, `useKnowledgeManager` three, `AdvancedPanel` two, and the agent editor two. Reading
// only the first meant the fence agreed with itself about one form per file and asked nothing at all
// of the rest — a declared name with no control behind it, in any of them, passed. Attributed per
// holder for the same reason `unheldWrites` names its handler: "this file declares a name it never
// renders" is not a finding anyone can act on.
//
// Read from the source rather than imported because the point is to compare the declaration against
// the RENDER, and only the source has both.
export function declarations(src: string): {
  holder: string;
  fields: string[];
}[] {
  return [...src.matchAll(/const (\w+) = useFieldRefusal\(/g)].map((m) => ({
    holder: m[1] as string,
    fields: declaredArg(
      argumentOf(src, (m.index as number) + (m[0] as string).length - 1),
      src,
    ),
  }));
}

// The text between a call's parentheses, balanced. Not a lazy match up to the next `);`, because the
// argument is an expression now and expressions nest.
function argumentOf(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

// Every name the argument can ever produce, whichever branch it takes.
//
// The argument is an EXPRESSION now — `modal.isOpen ? MCP_FIELDS : []`, `required ? WITH_TOKEN :
// BASE`, an array built one control at a time — so reading it as "one identifier, or one inline
// array" answers `[]` for almost every holder in the tree, and a rule that is handed nothing asks
// nothing. That is what this rule was written to catch and what it silently stopped seeing the
// moment the hook's argument changed shape: a fence with no findings and a fence with no vision are
// the same green.
//
// So: every string literal in the expression, plus every SCREAMING_CASE identifier in it that names
// a list in this file, resolved one level down so `[...SETUP_FIELDS, "token"]` contributes both. A
// computed element contributes nothing, which is the honest answer rather than a hole — a spread of
// `fields.map(f => f.key)` is read back by an `at(f.key, …)` the source cannot see either, so both
// sides of the comparison drop it together.
function declaredArg(arg: string, src: string): string[] {
  const out = new Set(literalsInLists(arg));
  for (const m of arg.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
    for (const name of resolveList(m[1] as string, src, 0)) out.add(name);
  }
  return [...out];
}

// A SCREAMING_CASE list declared in this file, following a spread into another one.
function resolveList(ident: string, src: string, depth: number): string[] {
  if (depth > 2) return [];
  const at = src.search(new RegExp(`\\b${ident}\\s*=\\s*\\[`));
  if (at < 0) return [];
  const body = argumentOf(src, src.indexOf("[", at));
  const out = new Set(literals(body));
  for (const m of body.matchAll(/\.\.\.([A-Z][A-Z0-9_]*)\b/g)) {
    for (const name of resolveList(m[1] as string, src, depth + 1)) {
      out.add(name);
    }
  }
  return [...out];
}

function literals(list: string): string[] {
  return [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
}

// Only the literals inside an ARRAY, because the expression also holds the condition that chooses
// between them: `addTab === "texto" ? DOC_FIELDS : []` names a tab, not a field, and reading it as
// one had the fence demanding a control for `texto`.
function literalsInLists(arg: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < arg.length; i++) {
    if (arg[i] !== "[") continue;
    const body = argumentOf(arg, i);
    out.push(...literals(body));
    i += body.length + 1;
  }
  return out;
}

// Every name declared anywhere in the file, which is what "did this handler send something the form
// named" asks: any holder's control can receive it.
export function declaredFields(src: string): string[] {
  return [...new Set(declarations(src).flatMap((d) => d.fields))];
}

// The names read back onto a control — by ONE holder when asked for one, since a name `refusal`
// declares is not rendered by `cloneRefusal.at(…)` two forms away.
export function readFields(src: string, holder?: string): Set<string> {
  const re = holder
    ? new RegExp(`\\b${holder}\\.at\\(\\s*["']([^"']+)["']`, "g")
    : /\.at\(\s*["']([^"']+)["']/g;
  return new Set([...src.matchAll(re)].map((m) => m[1] as string));
}

// A holder that is not cleared at EVERY opening of the dialog it belongs to.
//
// The component around a modal STAYS MOUNTED when the dialog closes — that is what `useOnModalOpen`
// exists for, resetting the form on each open — so a holder written into state survives the session
// that produced it. Reopening and typing the refused value again shows the old server sentence under
// the box without anything having been sent. The hook's own note says a holder must not outlive its
// form; a modal wrapper is exactly where "the form" and "the component" stop being the same thing.
//
// Per OPENING and per DIALOG, which the first version of this rule was neither. It pooled every
// reset block in the file into one string and asked whether the holder's name appeared anywhere in
// it, so one cleared opening vouched for all of them and one holder's clear vouched for the others.
// `ChannelsPage` has three dialogs and two ways into the connect one, and the way the operator
// actually uses — the Connect button — was the uncleared one.
//
// The attribution comes free from the holder itself: its second argument names the dialog whose
// `isOpen` it answers for (`connectModal.isOpen`), and each opening names its dialog too. A holder
// that names no dialog is a page's, and this rule has nothing to say about it — the page unmounts.
export function uncleanedHolders(src: string): string[] {
  const code = codeSkeleton(src);
  const out: string[] = [];
  for (const m of src.matchAll(/const (\w+) = useFieldRefusal\(([^;]*?)\);/g)) {
    const holder = m[1] as string;
    // DIALOGS, and deliberately not every state a holder is gated on.
    //
    // An inline editor needs the same per-session clear — `startEdit` re-seeds the form from a
    // record, so a mark from the last request stops being about anything on screen — and this rule
    // is not the place to demand it. Asking every gating state means asking the vault's
    // manual/`.env` toggle too, and clearing there would DELETE a correct mark: switching views does
    // not change the value the server refused. Separating "opens a session" from "switches a view"
    // needs to know what the setter re-seeds, which two attempts at a heuristic got wrong in
    // opposite directions. KnowledgeApprovals' clear is proved by a test instead.
    const guard = codeSkeleton(m[2] as string);
    const dialogs = [
      ...new Set(
        [...guard.matchAll(/\b(\w+)\.isOpen\b/g)].map((d) => d[1] as string),
      ),
    ];
    for (const dialog of dialogs) {
      for (const site of resetSites(src, code, dialog)) {
        if (!new RegExp(`\\b${holder}\\.clear\\(`).test(site)) {
          out.push(`${holder} (${dialog})`);
        }
      }
    }
  }
  return [...new Set(out)];
}

// Where one dialog's per-session reset has to live, which is ONE of two places.
//
// `useOnModalOpen(dialog, …)` is the hook for it and runs on every opening by construction, so where
// it exists it is the only site that matters and the buttons calling `.open()` are just buttons.
// Where it does not — a dialog seeded inline from the click that opens it, which is how the agent
// editor's clone dialog and the channels page's Connect button are written — the reset lives at each
// `.open()` and EVERY one of them has to carry it. Asking both of a file that has the hook flags
// every button in it; asking only the hook lets an inline dialog through with no reset at all.
function resetSites(src: string, code: string, dialog: string): string[] {
  const hooked: string[] = [];
  for (const m of code.matchAll(
    new RegExp(`useOnModalOpen\\(\\s*${dialog}\\b`, "g"),
  )) {
    let depth = 0;
    for (let i = m.index as number; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) {
        hooked.push(src.slice(m.index as number, i));
        break;
      }
    }
  }
  if (hooked.length > 0) return hooked;
  const inline: string[] = [];
  for (const m of code.matchAll(new RegExp(`\\b${dialog}\\.open\\(`, "g"))) {
    let depth = 0;
    for (let i = m.index as number; i >= 0; i--) {
      if (code[i] === "}") depth++;
      else if (code[i] === "{" && depth-- === 0) {
        inline.push(src.slice(i, m.index as number));
        break;
      }
    }
  }
  return inline;
}

// A holder that hands the hook a bare constant, which is the claim "every one of these is drawn,
// always".
//
// `rendered` is what the form is DRAWING, so the default is an expression and a bare list is the
// exception. The first two versions of this rule had it the other way round — they tried to work out
// whether the FILE hides anything, first from a list of shapes (a dialog, a tab) and then from the
// JSX around each reading — and each version missed the shape the next round found: an inline editor
// opened by `editingId === a.id`, whose two inputs are as absent as any dialog's while it is closed.
// Detecting a conditional render from source text is a real static-analysis question and string
// matching kept answering it with one more exclusion.
//
// Inverting it costs a ledger of eight and buys the property the shape list never had: a form added
// next week either says what it draws or writes down why it always draws everything. See
// ALWAYS_ON_SCREEN.
export function holdersBlindToTheScreen(src: string): string[] {
  return declarations(src)
    .filter((d) => /^\s*[A-Za-z_$][\w$]*\s*$/.test(argOf(src, d.holder)))
    .map((d) => d.holder);
}

function argOf(src: string, holder: string): string {
  const m = new RegExp(`const ${holder} = useFieldRefusal\\(`).exec(src);
  return m ? argumentOf(src, m.index + m[0].length - 1) : "";
}

// A field whose control is drawn BEHIND A GUARD, declared as though it always were.
//
// This is the per-control half of the rule above, and it took three review rounds to state because I
// kept trying to state it about the file: a dialog, then a tab, then an inline editor, then a mode
// toggle inside a form that is itself on screen. The thing being asked about was never the file. It
// is one JSX conditional, in the idiom this codebase writes it in — `{expr && (`, `{expr ? (` — with
// the expression carrying no parens or braces of its own, which is what keeps the search from
// walking out to the component body and calling every arrow and type annotation a guard.
//
// The demand is that the DECLARATION mention the STATE the guard turns on — `type` for
// `type === "webhook"`, `form.ackEnabled` for itself — which is exactly what a caller writes anyway
// (`type === "webhook" ? ALERT_WEBHOOK_FIELDS : ALERT_FIELDS`). Mentioning it rather than repeating
// the whole condition, because the two are not always spellable the same way: an inline editor's
// guard is `editingId === a.id`, per row, and the holder above the rows has only `editingId`. What
// makes this checkable at all is that it never has to decide whether one expression implies another.
//
// Run over the tree it named eighteen guarded controls, six of which were declared unconditionally —
// two the review found and four it had not reached.
const JSX_GUARD = /\{\s*[^{}()]*?(?:&&|\?)\s*$/;

export function guardOf(
  src: string,
  holder: string,
  field: string,
): string | null {
  const code = codeSkeleton(src);
  const re = new RegExp(
    `\\b${holder}\\.at\\(\\s*["']${field}["']|\\b${holder}\\.at\\(\\s*\\n\\s*["']${field}["']`,
    "g",
  );
  for (const m of src.matchAll(re)) {
    const at = m.index as number;
    const opens: number[] = [];
    for (let i = 0; i < at; i++) {
      const c = code[i];
      if (c === "(" || c === "{") opens.push(i);
      else if (c === ")" || c === "}") opens.pop();
    }
    // Innermost first: an outer guard is about the screen, and the one this control answers to is
    // the nearest one.
    for (const o of opens.reverse()) {
      const from = Math.max(0, o - 120);
      const g = JSX_GUARD.exec(code.slice(from, o));
      if (!g) continue;
      return src
        .slice(from + (g.index as number), o)
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return null;
}

// The state a guard turns on: the leading identifier chain, past any `!`. `form.ackEnabled` and not
// `form`, because half this tree's guards hang off one `form` object and the root alone would let
// any of them vouch for any other.
function stateOf(guard: string): string {
  return (
    /^\{\s*!*\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)/.exec(
      guard,
    )?.[1] ?? guard
  );
}

export function guardedButUnconditional(src: string): string[] {
  const out: string[] = [];
  for (const d of declarations(src)) {
    const arg = argOf(src, d.holder).replace(/\s+/g, " ");
    for (const field of d.fields) {
      const guard = guardOf(src, d.holder, field);
      if (!guard) continue;
      if (!arg.includes(stateOf(guard)))
        out.push(`${d.holder}.${field} <- ${guard}`);
    }
  }
  return out;
}

// A reading that CANNOT run, because the `??` in front of it never falls through.
//
// `at(…)` answers `string | null`, so it reads naturally as the fallback of a local validation
// error — and it is dead there whenever that local error is a state initialized to `""`, since an
// empty string is not nullish. Nothing about this is visible: the name is declared, the reading is
// written, the fence's other rule sees an `at(…)` and is satisfied, and the refusal is placed onto a
// holder whose one reader can never return it. `capture` has already told the caller "it is on the
// control", so the toast stays quiet too. Measured on `useKnowledgeManager`: the chunk-size box
// checks BOUNDS locally and the schema is `t.Integer`, so a size of 100.5 is refused by name and
// answered with nothing at all.
//
// The left operand is the whole test. `refusal.at(a) ?? refusal.at(b)` — one control drawn for two
// names, which ToolEditModal does — falls through exactly as intended.
export function deadReadings(src: string): string[] {
  const neverNullish = new Set(
    [...src.matchAll(/const \[(\w+),[^\]]*\]\s*=\s*useState\(\s*["'`]/g)].map(
      (m) => m[1] as string,
    ),
  );
  if (neverNullish.size === 0) return [];
  return [
    ...codeSkeleton(src).matchAll(
      /\b([A-Za-z_$][\w$]*)\s*\?\?\s*([A-Za-z_$][\w$]*)\.at\(/g,
    ),
  ]
    .filter((m) => neverNullish.has(m[1] as string))
    .map((m) => `${m[2]}.at behind ${m[1]}`);
}

export function silentDeclarations(src: string): string[] {
  return declarations(src).flatMap(({ holder, fields }) => {
    const read = readFields(src, holder);
    return fields.filter((n) => !read.has(n)).map((n) => `${holder}.${n}`);
  });
}

// A form that writes and does not hold its refusal, with the reason. Asserted in both directions, so
// an entry describing code that no longer exists fails too.
const NOT_A_REFUSABLE_FORM: Record<string, string> = {
  "components/GoogleOAuthSection.tsx":
    "Its POSTs are the OAuth dance itself — authorize and disconnect — with no value of the operator's in the body. The fields it renders are the connected account, read-only.",
  "components/McpOAuthSection.tsx":
    "Same section, same two calls, same reason: nothing here is a value the server can refuse by name.",
};

// A holder whose form cannot be hidden, in a file that can hide something else. Separate from the
// ledger above because the two rules ask different questions, and one entry answers only one of
// them: the agent editor's holder is a page's for the clearing rule and a hidden form's for this
// one. Waiving it in both was how the tab case survived the round that found the modal case.
const ALWAYS_ON_SCREEN: Record<string, string> = {
  "components/BusinessHoursForm.tsx :: refusal":
    "The schedule editor IS the screen it is on, and its four controls are drawn together. The windows and exceptions lists grow and shrink; the controls that hold them do not.",
  "pages/LoginPage.tsx :: refusal":
    "Two boxes, both always drawn. The page unmounts on a successful login, which the mounted check already answers.",
  "pages/SignupPage.tsx :: refusal": "Same two boxes, same reason.",
  "pages/settings/SettingsProfilePage.tsx :: refusal":
    "The password form is a section of the page, drawn whenever the page is.",
  "pages/resources/documents/CompanyProfileCard.tsx :: refusal":
    "The profile fields are the card's body; the card is either mounted or it is not.",
  "pages/resources/AdvancedPanel.tsx :: embRefusal":
    "One credential picker, drawn with the panel.",
  "pages/resources/AdvancedPanel.tsx :: lfRefusal":
    "The Langfuse credential picker, likewise. The enable switch hides the SETTINGS below it, not the picker this holder names.",
};

// A form that holds SOME of its refusals, with what is left. Neither rule above can see this — rule
// 1 is satisfied by the hook being called at all — so it is a declaration, pinned by size, and the
// only thing keeping the sweep honest about where it stopped.
// EMPTY since #349, and kept rather than deleted: the shape is the place a future form declares what
// it stopped at, and a pin of zero makes adding one cost the second edit the ledger exists to force.
//
// What emptied it: the agent editor now declares every value it writes — twenty-three names over four
// tabs — and hands the answers to the tabs that draw them. The half that was missing was never the
// mark, it was that a mark on a tab nobody is looking at is silence, so the editor announces the ones
// it holds off screen in a banner that carries the way to the control (see `refusalAway`).
const PARTIALLY_HELD: Record<string, string> = {};

describe("a form that writes holds the refusal it gets", () => {
  test("every partially held form still holds something", () => {
    // Both directions: an entry describing a file that stopped calling the hook is describing code
    // that no longer exists, and an entry for a file that got fully wired should be deleted.
    for (const file of Object.keys(PARTIALLY_HELD)) {
      expect(
        readFileSync(join(ROOT, file), "utf8").includes("useFieldRefusal"),
        `${file} is listed as partially held and holds nothing`,
      ).toBe(true);
    }
  });

  test("the partial ledger is pinned to its size", () => {
    expectWaiverLedger("PARTIALLY_HELD", PARTIALLY_HELD, 0);
  });

  test("the predicate sees a form that writes", () => {
    expect(
      writesAForm(`
        <FormField label="x"><Input value={v} /></FormField>

  async function save() {
    const { error } = await api.api.v1.tools.post(body);
  }
      `),
    ).toBe(true);
  });

  test("a POST that asks for a list is not a write", () => {
    // The model and voice catalogs are POSTed because the query is a body, not because anything of
    // the operator's is being stored. A form next to one of those has nothing to place.
    expect(
      writesAForm(`
        <Select value={v} />

  async function loadVoices() {
    const { data } = await api.api.v1.agents.models.list.post({ provider });
  }
      `),
    ).toBe(false);
  });

  test("a screen with no control is not a form", () => {
    expect(
      writesAForm(`
  async function save() {
    const { error } = await api.api.v1.agents.post(body);
  }
      `),
    ).toBe(false);
  });

  test("a handler ends at its own brace, not at the next declaration", () => {
    // A nested component's last handler used to swallow everything after it, which read a callback
    // that awaits nothing as a write of the function three declarations below.
    const src = `
  async function select(next: string | null) {
    await onChange(next);
  }

  function Other() {
    return null;
  }

  async function save() {
    await api.api.v1.tools.post(body);
  }
    `;
    expect(writeHandlers(src)).toEqual(["save"]);
  });

  test("a declared name inside a COMMENT is not a form write", () => {
    // Measured on `useKnowledgeManager`: the reindex button sends no body at all, and the only
    // mention of a declared name inside it is a comment that says "Same text as the banner".
    const src = `
      const F = ["title", "text"] as const;
      const r = useFieldRefusal(F, m.isOpen);
      <FormField error={r.at("title", v)} /><FormField error={r.at("text", w)} />

  async function reindex(id: string) {
    // Same text as the banner, from the same function.
    const { error } = await api.bases({ id }).reindex.post();
  }
    `;
    expect(unheldWrites(src)).toEqual([]);
  });

  test("an unheld handler is named, even next to a held one", () => {
    // The shape the file-level rule could not see: two forms in one file, one wired.
    const src = `
      const A = ["x", "y"] as const;
      const a = useFieldRefusal(A);
      <FormField error={a.at("x", v)} />

  async function saveA() {
    const { error } = await api.thing.post({ x });
    if (error) setErr(a.capture(error, f, sent, current));
  }

  async function saveB() {
    const { error } = await api.other.post({ y });
    if (error) setErr("nope");
  }

  async function revoke() {
    const { error } = await api.thing({ id }).revoke.post();
    if (error) setErr("nope");
  }
    `;
    expect(unheldWrites(src)).toEqual(["saveB"]);
  });

  test("a holder that is read and never captured is flagged", () => {
    const src = `
      const addDocRefusal = useFieldRefusal(DOC_FIELDS);
      <FormField error={addDocRefusal.at("title", v)} />
    `;
    expect(halfUsedHolders(src)).toEqual(["addDocRefusal (never captured)"]);
  });

  test("a holder that is captured and never read is flagged too", () => {
    const src = `
      const r = useFieldRefusal(F);
      setError(r.capture(e, f, sent, current));
    `;
    expect(halfUsedHolders(src)).toEqual(["r (never read)"]);
  });

  test("a control drawn behind a guard is declared behind the same one", () => {
    const blind = sources(ROOT).flatMap((f) =>
      guardedButUnconditional(readFileSync(f, "utf8")).map(
        (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
      ),
    );
    expect(
      blind,
      "this control is only drawn under that condition, so declaring it always puts the server's sentence on nothing and keeps the toast quiet: mirror the guard in the list",
    ).toEqual([]);
  });

  test("the predicate flags a field drawn behind a switch", () => {
    const src = `
      const F = ["name", "secretRef"] as const;
      const r = useFieldRefusal(m.isOpen ? F : []);
      <Input error={r.at("name", n)} />
      {type === "webhook" && (
        <CredentialPicker error={r.at("secretRef", s)} />
      )}
    `;
    expect(guardedButUnconditional(src)).toEqual([
      'r.secretRef <- {type === "webhook" &&',
    ]);
  });

  test("a declaration that mirrors the guard is not flagged", () => {
    const src = `
      const F = ["name"] as const;
      const WF = [...F, "secretRef"] as const;
      const r = useFieldRefusal(type === "webhook" ? WF : F);
      <Input error={r.at("name", n)} />
      {type === "webhook" && (
        <CredentialPicker error={r.at("secretRef", s)} />
      )}
    `;
    expect(guardedButUnconditional(src)).toEqual([]);
  });

  test("the badge idiom is not a guard", () => {
    // `{r.at(x) && (<span/>)}` guards on the refusal itself and says nothing about whether the
    // control is drawn. It needs no clause of its own: the pattern only accepts a condition that
    // ends the text before the delimiter, and here the reading it would flag sits past a `<span>`.
    // Measured — an explicit exclusion for it was dead in both directions.
    const src = `
      const F = ["windows"] as const;
      const r = useFieldRefusal(F);
      {r.at("windows", w) && (
        <span className="text-error">{r.at("windows", w)}</span>
      )}
    `;
    expect(guardedButUnconditional(src)).toEqual([]);
  });

  test("no reading sits behind a fallback that never falls through", () => {
    const dead = sources(ROOT).flatMap((f) =>
      deadReadings(readFileSync(f, "utf8")).map(
        (d) => `${f.slice(`${ROOT}/`.length)} :: ${d}`,
      ),
    );
    expect(
      dead,
      'a local error state initialized to "" is never nullish, so the refusal behind `??` is unreachable and the toast is already quiet: use `||`',
    ).toEqual([]);
  });

  test("the predicate flags a refusal behind an empty-string local error", () => {
    const src = `
      const [chunkSizeError, setChunkSizeError] = useState("");
      <FormField error={chunkSizeError ?? r.at("chunkSize", v)} />
    `;
    expect(deadReadings(src)).toEqual(["r.at behind chunkSizeError"]);
  });

  test("the same reading behind a truthy fallback is fine", () => {
    const src = `
      const [chunkSizeError, setChunkSizeError] = useState("");
      <FormField error={chunkSizeError || r.at("chunkSize", v)} />
    `;
    expect(deadReadings(src)).toEqual([]);
  });

  test("a local error that CAN be null keeps its fallback", () => {
    // The filter's own control: the rule is about a state that is never nullish, not about `??`.
    // A nullable local error is the shape this pattern is written for.
    const src = `
      const [touched, setTouched] = useState("");
      const localError = invalid ? "Must be a number." : null;
      <FormField error={localError ?? r.at("chunkSize", v)} />
    `;
    expect(deadReadings(src)).toEqual([]);
  });

  test("one control drawn for two names still falls through", () => {
    // `at(…)` answers null when it is not the refused name, which is exactly what `??` is for.
    const src = `
      const [x, setX] = useState("");
      <FormField error={r.at("label", a) ?? r.at("name", b)} />
    `;
    expect(deadReadings(src)).toEqual([]);
  });

  test("a declared name with no control behind it is flagged", () => {
    const src = `
      const FIELDS = ["name", "allowedHosts"] as const;
      const refusal = useFieldRefusal(FIELDS);
      <FormField error={refusal.at("name", current.name)} />
    `;
    expect(silentDeclarations(src)).toEqual(["refusal.allowedHosts"]);
  });

  test("the second holder of a file is asked the same question", () => {
    // The shape the first-call-only version could not see: two forms, and the one that is wrong is
    // not the one declared first.
    const src = `
      const A = ["name"] as const;
      const B = ["name", "slug"] as const;
      const a = useFieldRefusal(A, x.isOpen);
      const b = useFieldRefusal(B, y.isOpen);
      <FormField error={a.at("name", u)} />
      <FormField error={b.at("name", v)} />
    `;
    expect(silentDeclarations(src)).toEqual(["b.slug"]);
  });

  test("a name read by ANOTHER holder does not answer for this one", () => {
    // Two forms with a `name` each is the normal case here — a modal over the panel that opened it —
    // and a file-wide reading let one form's control vouch for the other's declaration.
    const src = `
      const A = ["name"] as const;
      const B = ["name"] as const;
      const a = useFieldRefusal(A, x.isOpen);
      const b = useFieldRefusal(B, y.isOpen);
      <FormField error={a.at("name", u)} />
    `;
    expect(silentDeclarations(src)).toEqual(["b.name"]);
  });

  test("a list chosen by a condition is read on both branches", () => {
    // The shape almost every holder has now, and the one an identifier-or-array reader answers `[]`
    // for — which would leave the whole sweep green and blind.
    const src = `
      const A = ["name", "slug"] as const;
      const r = useFieldRefusal(modal.isOpen ? A : []);
      <FormField error={r.at("name", u)} />
    `;
    expect(silentDeclarations(src)).toEqual(["r.slug"]);
  });

  test("a condition's own strings are not fields", () => {
    // `addTab === "texto"` names a tab. Reading the expression's literals flat had the fence
    // demanding a control for it.
    const src = `
      const DOC = ["title"] as const;
      const r = useFieldRefusal(m.isOpen && addTab === "texto" ? DOC : []);
      <FormField error={r.at("title", u)} />
    `;
    expect(silentDeclarations(src)).toEqual([]);
  });

  test("a list spread into another contributes both", () => {
    const src = `
      const BASE = ["email", "password"] as const;
      const WITH_TOKEN = [...BASE, "token"] as const;
      const r = useFieldRefusal(required ? WITH_TOKEN : BASE);
      <FormField error={r.at("email", u)} />
      <FormField error={r.at("password", v)} />
    `;
    expect(silentDeclarations(src)).toEqual(["r.token"]);
  });

  test("an inline field list is read, not skipped", () => {
    // `CredentialForm` builds its list from the secret type it is drawing. The identifier-only
    // version returned nothing for it, so the whole form was outside the fence.
    const src = `
      const refusal = useFieldRefusal([
        "name",
        "value",
        ...(fields ?? []).map((f) => f.key),
      ]);
      <FormField error={refusal.at("name", u)} />
    `;
    expect(silentDeclarations(src)).toEqual(["refusal.value"]);
  });

  test("a declared name that is read is not flagged", () => {
    const src = `
      const FIELDS = ["name"] as const;
      const refusal = useFieldRefusal(FIELDS);
      <FormField error={refusal.at("name", current.name)} />
    `;
    expect(silentDeclarations(src)).toEqual([]);
  });

  test("every handler that writes a form holds its refusal", () => {
    const unheld = sources(ROOT).flatMap((f) => {
      const file = f.slice(`${ROOT}/`.length);
      if (file in NOT_A_REFUSABLE_FORM) return [];
      return unheldWrites(readFileSync(f, "utf8")).map(
        (h) => `${file} :: ${h}`,
      );
    });
    expect(
      unheld,
      "these write a form and send every refusal to a banner: route the failure through refusal.capture, or name the reason not to",
    ).toEqual([]);
  });

  test("every branch of a held handler goes through the holder", () => {
    const unheld = sources(ROOT).flatMap((f) =>
      unheldBranches(readFileSync(f, "utf8")).map(
        (b) => `${f.slice(`${ROOT}/`.length)} :: ${b}`,
      ),
    );
    expect(
      unheld,
      "one wired branch answers for the handler but not for the operator: route this write through the holder too",
    ).toEqual([]);
  });

  test("the predicate flags the branch a wired handler forgot", () => {
    // Eden rejects on a transport failure instead of answering `{ error }`, so the branch that is
    // easiest to leave unwired is the one a broken network lands in.
    const src = `
      const r = useFieldRefusal(F, m.isOpen);

  const handleSubmit = async () => {
    setError("");
    const held = (e) => r.capture(e, fallback, sent, current);
    try {
      const { error } = await api.thing.post(body);
      if (error) {
        setError(held(error));
        return;
      }
    } catch {
      setError(t("alerts.saveFailed", "Could not save the channel"));
    }
  };
    `;
    expect(unheldBranches(src)).toEqual([
      'handleSubmit :: t("alerts.saveFailed", "Could not save the channel")',
    ]);
  });

  test("a check made before the request is not a refusal", () => {
    // "Passwords do not match" and "Headers must be valid JSON." are decided here, with no server
    // asked, and they return before anything is sent.
    const src = `
      const r = useFieldRefusal(F, m.isOpen);

  const handleSubmit = async () => {
    if (a !== b) {
      setError(t("auth.passwordsNoMatch", "Passwords do not match"));
      return;
    }
    const held = (e) => r.capture(e, fallback, sent, current);
    const { error } = await api.thing.post(body);
    if (error) setError(held(error));
  };
    `;
    expect(unheldBranches(src)).toEqual([]);
  });

  test("a handler with no holder at all is another rule's business", () => {
    // `unheldWrites` names those. Asking twice would report one defect as two.
    const src = `
      const r = useFieldRefusal(F, m.isOpen);

  const other = async () => {
    await api.thing.post(body);
    setError("nope");
  };
    `;
    expect(unheldBranches(src)).toEqual([]);
  });

  test("clearing the line is not a write", () => {
    const src = `
      const r = useFieldRefusal(F, m.isOpen);

  const save = async () => {
    setError("");
    setFormError(null);
    setError(r.capture(e, f, sent, current));
  };
    `;
    expect(unheldBranches(src)).toEqual([]);
  });

  test("no caller substitutes a sentence for the hook's null", () => {
    const distrusted = sources(ROOT).flatMap((f) =>
      distrustedNulls(readFileSync(f, "utf8")).map(
        (d) => `${f.slice(`${ROOT}/`.length)} :: ${d}`,
      ),
    );
    expect(
      distrusted,
      "null is the hook saying the operator has already been told: `if (toast) showToast(toast)`, never `toast ?? fallback`",
    ).toEqual([]);
  });

  test("the predicate flags a fallback substituted for null", () => {
    const src = `
      const r = useFieldRefusal(m.isOpen ? F : []);
  const save = async () => {
    try {
      await api.thing.post(body);
    } catch (e) {
      const toast = r.capture(e, fallback, sent, current);
      showToast(toast ?? t("company.saveError", "Could not save."), "error");
    }
  };
    `;
    expect(distrustedNulls(src)).toEqual(['?? t("company.saveError"']);
  });

  test("coercing null to an empty string is not a second sentence", () => {
    // The auth pages feed a `string` state, and `""` renders nothing. Only words are a second
    // channel.
    const src = `
      const r = useFieldRefusal(m.isOpen ? F : []);
  const submit = async () => {
    const held = (e) => r.capture(e, fallback, sent, current);
    setError(held(apiError) ?? "");
  };
    `;
    expect(distrustedNulls(src)).toEqual([]);
  });

  test("guarding on the sentence is not distrusting the null", () => {
    const src = `
      const r = useFieldRefusal(m.isOpen ? F : []);
  const save = async () => {
    const toast = r.capture(e, fallback, sent, current);
    if (toast) showToast(toast, "error");
  };
    `;
    expect(distrustedNulls(src)).toEqual([]);
  });

  test("no staleness check compares a value with itself", () => {
    const tautological = sources(ROOT).flatMap((f) =>
      tautologicalStaleness(readFileSync(f, "utf8")).map(
        (a) => `${f.slice(`${ROOT}/`.length)} :: ${a}`,
      ),
    );
    expect(
      tautological,
      "`sent` and `current` are the request's value and the box's value: handing over the same one makes the check a tautology and the mark unreadable",
    ).toEqual([]);
  });

  test("the predicate flags sent and current being one snapshot", () => {
    const src = `
      r.capture(e, fallback, { accountIds: wanted }, { accountIds: wanted });
    `;
    expect(tautologicalStaleness(src)).toEqual(["{ accountIds: wanted }"]);
  });

  test("a live read against the snapshot is not flagged", () => {
    const src = `
      r.capture(e, fallback, { accountIds: wanted }, { accountIds: ref.current });
    `;
    expect(tautologicalStaleness(src)).toEqual([]);
  });

  test("no holder is declared and half-used", () => {
    const half = sources(ROOT).flatMap((f) =>
      halfUsedHolders(readFileSync(f, "utf8")).map(
        (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
      ),
    );
    expect(
      half,
      "a holder that is only read places nothing, and one that is only captured shows nothing",
    ).toEqual([]);
  });

  test("no form declares a name it never renders", () => {
    const silent = sources(ROOT).flatMap((f) =>
      silentDeclarations(readFileSync(f, "utf8")).map(
        (name) => `${f.slice(`${ROOT}/`.length)} :: ${name}`,
      ),
    );
    expect(
      silent,
      "a declared name with no `at(…)` behind it swallows its refusal: render it, or stop declaring it",
    ).toEqual([]);
  });

  test("a holder inside a modal is cleared when the modal opens", () => {
    // No ledger under this one, and that is the rule earning its keep: it used to need two waivers
    // saying "this holder belongs to the page, not to the dialog in the same file", and now the
    // holder says which dialog it belongs to and the ones that name none are simply not asked.
    const uncleaned = sources(ROOT).flatMap((f) =>
      uncleanedHolders(readFileSync(f, "utf8")).map(
        (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
      ),
    );
    expect(
      uncleaned,
      "the component outlives the dialog, so a mark from the last session is still held when it reopens: clear the holder in useOnModalOpen",
    ).toEqual([]);
  });

  test("a holder in a file that hides controls answers with what it draws", () => {
    const blind = sources(ROOT)
      .flatMap((f) =>
        holdersBlindToTheScreen(readFileSync(f, "utf8")).map(
          (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
        ),
      )
      .filter((h) => !(h in ALWAYS_ON_SCREEN));
    expect(
      blind,
      "a bare constant claims every one of these is drawn, always: hand the hook the list it is DRAWING, or name the form in ALWAYS_ON_SCREEN",
    ).toEqual([]);
  });

  test("every always-on-screen entry describes a holder that still exists", () => {
    // Both directions, like the other ledgers here: an entry for a holder that has since started
    // answering with an expression is describing code that is not there any more, and it would go on
    // waiving whatever took its place. The branding page's holder became conditional the round this
    // assertion was written, and nothing else noticed.
    const flagged = new Set(
      sources(ROOT).flatMap((f) =>
        holdersBlindToTheScreen(readFileSync(f, "utf8")).map(
          (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
        ),
      ),
    );
    expect(
      Object.keys(ALWAYS_ON_SCREEN).filter((k) => !flagged.has(k)),
      "these are waived and no longer flagged: delete the entry",
    ).toEqual([]);
  });

  test("the always-on-screen ledger is pinned to its size", () => {
    expectWaiverLedger("ALWAYS_ON_SCREEN", ALWAYS_ON_SCREEN, 7);
  });

  test("the predicate flags a holder that claims every field, always", () => {
    const src = `
      const refusal = useFieldRefusal(FIELDS);
      {modal.isOpen && <FormField error={refusal.at("name", v)} />}
    `;
    expect(holdersBlindToTheScreen(src)).toEqual(["refusal"]);
  });

  test("a form behind a tab is asked the same question as one behind a dialog", () => {
    // No dialog in sight, and the form is hidden just as completely: `GeneralTab` is not mounted
    // while the operator reads another tab, and a save started before the switch answers after it.
    const src = `
      const refusal = useFieldRefusal(EDITOR_FIELDS);
      {tab === "general" ? (
        <FormField error={refusal.at("name", v)} />
      ) : null}
    `;
    expect(holdersBlindToTheScreen(src)).toEqual(["refusal"]);
  });

  test("a holder that answers with an expression is not flagged", () => {
    // One form reached from two dialogs answers for both, and a form that hides one control answers
    // for that too. What it answers with is the caller's business.
    const src = `
      const refusal = useFieldRefusal(a.isOpen || b.isOpen ? FIELDS : []);
      {a.isOpen && <FormField error={refusal.at("name", v)} />}
    `;
    expect(holdersBlindToTheScreen(src)).toEqual([]);
  });

  test("a page's form is flagged too, and answers in the ledger", () => {
    // The inversion: a bare list is the exception, not the default. A form that really does draw all
    // of them says so once, by name, in ALWAYS_ON_SCREEN — which is a sentence someone wrote, not a
    // shape a regex guessed.
    const src = `
      const refusal = useFieldRefusal(BRANDING_FIELDS);
      <FormField error={refusal.at("name", v)} />
    `;
    expect(holdersBlindToTheScreen(src)).toEqual(["refusal"]);
  });

  test("an inline editor guards its readings like any dialog", () => {
    // The shape the file-shape list missed: no dialog, no tab, and the two inputs are as absent as
    // any modal's while `editingId` is null.
    const src = `
      const refusal = useFieldRefusal(APPROVAL_FIELDS);
      {editingId === a.id ? (
        <Input error={refusal.at("title", draft.title)} />
      ) : (
        <p>{a.title}</p>
      )}
    `;
    expect(holdersBlindToTheScreen(src)).toEqual(["refusal"]);
  });

  test("a per-control list is an answer too", () => {
    const src = `
      const refusal = useFieldRefusal([
        "name",
        ...(needsParamName ? ["paramName"] : []),
      ]);
      {needsParamName && <Input error={refusal.at("paramName", v)} />}
    `;
    expect(holdersBlindToTheScreen(src)).toEqual([]);
  });

  test("the predicate flags a modal holder that is never cleared", () => {
    const src = `
      const refusal = useFieldRefusal(F, modal.isOpen);
      useOnModalOpen(modal, () => {
        setName("");
      });
    `;
    expect(uncleanedHolders(src)).toEqual(["refusal (modal)"]);
  });

  test("one cleared opening does not vouch for another", () => {
    // The shape the pooled version could not see, and it is the one the operator uses: the deep-link
    // path clears, the button beside it does not, and the mark comes back on the value it refused.
    const src = `
      const connectRefusal = useFieldRefusal(F, connectModal.isOpen);
      useEffect(() => {
        connectRefusal.clear();
        connectModal.open();
      }, [x]);

      function openConnect() {
        setBaseUrl("");
        connectModal.open();
      }
    `;
    expect(uncleanedHolders(src)).toEqual(["connectRefusal (connectModal)"]);
  });

  test("the buttons of a hooked dialog are not reset sites", () => {
    // `useOnModalOpen` runs on every opening, so where it exists it IS the per-session reset and the
    // `.open()` calls scattered through the JSX have nothing to carry.
    const src = `
      const refusal = useFieldRefusal(F, modal.isOpen);
      useOnModalOpen(modal, () => {
        setName("");
        refusal.clear();
      });
      <Button onClick={() => modal.open({})} />
      <Button onClick={() => modal.open({ channel: ch })} />
    `;
    expect(uncleanedHolders(src)).toEqual([]);
  });

  test("one holder's clear does not vouch for another dialog's", () => {
    const src = `
      const a = useFieldRefusal(F, aModal.isOpen);
      const b = useFieldRefusal(F, bModal.isOpen);
      useOnModalOpen(aModal, () => {
        a.clear();
      });
      useOnModalOpen(bModal, () => {
        setName("");
      });
    `;
    expect(uncleanedHolders(src)).toEqual(["b (bModal)"]);
  });

  test("a holder that names no dialog is not this rule's business", () => {
    // A page's holder. The page unmounts when the operator leaves it, so it cannot outlive its form
    // the way a modal's does, and clearing it when an unrelated dialog opens would mean nothing.
    const src = `
      const refusal = useFieldRefusal(BRANDING_FIELDS);
      cropper.open();
    `;
    expect(uncleanedHolders(src)).toEqual([]);
  });

  test("a dialog seeded from a click is asked the same question", () => {
    // The agent editor's clone dialog has no `useOnModalOpen`: it seeds its input and opens in one
    // onClick, and the holder survives the close exactly the same way.
    const src = `
      const cloneRefusal = useFieldRefusal(F, cloneModal.isOpen);
      onClick={() => {
        setCloneName(suggested);
        cloneModal.open();
      }}
    `;
    expect(uncleanedHolders(src)).toEqual(["cloneRefusal (cloneModal)"]);
  });

  test("a modal holder cleared on open is not flagged", () => {
    const src = `
      const refusal = useFieldRefusal(F, modal.isOpen);
      useOnModalOpen(modal, () => {
        setName("");
        refusal.clear();
      });
    `;
    expect(uncleanedHolders(src)).toEqual([]);
  });

  test("the abstention ledger is pinned to its size", () => {
    expectWaiverLedger("NOT_A_REFUSABLE_FORM", NOT_A_REFUSABLE_FORM, 2);
  });
});
