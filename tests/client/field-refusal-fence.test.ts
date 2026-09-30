import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expectWaiverLedger } from "@/tests/utils/ledger";
import { codeSkeleton } from "@/tests/utils/source-text";

// The guard against a form that sends a field refusal to a banner. The server names the refused
// field and `useFieldRefusal` renders it at the control; a form that drops the server's sentence
// into a toast or an error line leaves the operator counting fields to find the one it meant.
// Two rules, because a form can fail in two directions and only one is visible:
//   1. a form that WRITES holds its refusal: `useFieldRefusal`, or a named reason not to;
//   2. every name a form DECLARES is read back by an `at(…)` call in the same file. A declared name
//      with no control is worse than none: `placeRefusal` marks it placed and the caller keeps the
//      toast silent, so the refusal reaches nobody.

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

// One function of a component, by name. Both spellings this tree uses (`async function save()` and
// `const submit = async () => {`) at the component's own indentation, so a callback nested inside
// one is part of its body rather than a handler of its own. Named, not merely located: a file with
// six forms is not answered by "this file calls the hook somewhere".
const HANDLER_HEAD =
  /\n {2}(?:export )?(?:async function (\w+)|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>|function (\w+))/g;

export function handlers(src: string): {
  name: string;
  body: string;
  // The same span with comments and string CONTENTS blanked out, offsets preserved. Every
  // question asked of a handler is about what it runs, and prose mentions the same words innocently
  // (a comment inside a body-less button handler can name a declared field).
  code: string;
}[] {
  // Bounded by its own closing brace, not by where the next handler starts: slicing to the
  // next head makes the LAST handler of a nested component swallow everything after it, so a
  // callback that awaits nothing would read as a write of a function declared below it.
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
// refusal holder. Declared is what bounds it: a handler that sends nothing the form named cannot
// receive a refusal about an input. That separates a submit from the actions beside it
// (`revoke.post()` has no body, `toggleEnabled` sends one switch, `saveGuardrails` sends a bag whose
// paths this page does not declare, see PARTIALLY_HELD). Asking every write would flag mostly non-forms.
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
// `unheldWrites` is answered by one `capture` anywhere in a handler, so a `catch` writing a fixed
// sentence beside a wired resolved-error branch passes it; Eden REJECTS on a transport failure, so
// that catch is the branch a failed network hits. Only branches AFTER the request went out, and
// only ones that write a SENTENCE: a pre-submit guard ("Passwords do not match") or a clearing
// `setError("")` has no server answer to route.
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

// A caller that does not believe the hook's null. `capture` answers "is there anything left for YOU
// to say", and null is "no": the sentence is on the control, or the hook raised the global toast
// itself. Substituting a fallback (`toast ?? t("…saveError")`) fires the second channel on top of
// the first: a message under the box AND a toast repeating it, or two identical toasts.
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

// A staleness check that compares a value with itself. `capture` takes what the request CARRIED and
// what the inputs hold NOW, and refuses to mark a control that has moved on. The same expression
// twice makes that a tautology (always placed) while the render reads the live value and finds no
// mark, so the refusal reaches neither channel (e.g. a picker whose rows stay live during a PUT).
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
// captures into answers null at every `at(…)`, and one nobody reads keeps the toast quiet about a
// refusal placed nowhere. A holder can be used through a REGISTER (the agent editor's
// `refusals[section].capture(...)`): then the register must be captured and read, and each holder
// must be IN it. Keyed off the `Record<_, FieldRefusal>` annotation, so a file cannot opt out by
// listing holders in an unannotated bag.
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
  // `.at\b` rather than `.at(`: a page with several holders passes the method as a REFERENCE
  // (`refusals[s].at`) to an aggregate, and requiring the call site would force a worse shape.
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

// EVERY holder in the file with the names it declares, not the first one that appears: several
// pages keep two or three holders, and reading only the first asks nothing of the rest. Attributed
// per holder, like `unheldWrites` names its handler, so a finding is actionable.
// Read from the source rather than imported, because the declaration is compared against the
// RENDER, and only the source has both.
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
// argument is an expression and expressions nest.
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

// Every name the argument can ever produce, whichever branch it takes. The argument is an
// EXPRESSION (`modal.isOpen ? MCP_FIELDS : []`, `required ? WITH_TOKEN : BASE`), so reading it as
// "one identifier or one inline array" would answer `[]` for almost every holder: a fence with no
// vision is as green as one with no findings. So: every string literal in it plus every
// SCREAMING_CASE list of this file, resolved one level down (`[...SETUP_FIELDS, "token"]`). A computed
// element contributes nothing, and its `at(f.key, …)` reading is invisible too, so both drop together.
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
// between them: `addTab === "texto" ? DOC_FIELDS : []` names a tab, not a field.
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

// A holder that is not cleared at EVERY opening of the dialog it belongs to. The component around a
// modal STAYS MOUNTED on close (hence `useOnModalOpen`), so a holder in state survives its session,
// and reopening shows the old server sentence before anything was sent. Asked per OPENING and per
// DIALOG: one cleared opening must not vouch for another, nor one holder's clear for others. The
// holder's second argument names its dialog (`connectModal.isOpen`); one naming none is a page's,
// and the page unmounts.
export function uncleanedHolders(src: string): string[] {
  const code = codeSkeleton(src);
  const out: string[] = [];
  for (const m of src.matchAll(/const (\w+) = useFieldRefusal\(([^;]*?)\);/g)) {
    const holder = m[1] as string;
    // DIALOGS, and deliberately not every state a holder is gated on. An inline editor needs
    // the same per-session clear (`startEdit` re-seeds from a record), but asking every gating state
    // would also clear on the vault's manual/`.env` toggle and DELETE a correct mark. Telling a
    // session from a view switch needs to know what the setter re-seeds, which no heuristic here
    // gets right; KnowledgeApprovals' clear is proved by a test instead.
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

// Where one dialog's per-session reset has to live: ONE of two places. `useOnModalOpen(dialog, …)`
// runs on every opening, so where it exists it is the only site that matters. Where it does not (a
// dialog seeded inline from the click that opens it, like the agent editor's clone dialog), the
// reset lives at each `.open()` and EVERY one must carry it. Asking both would flag every button.
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

// A holder that hands the hook a bare constant, which claims "every one of these is always drawn".
// `rendered` is what the form is DRAWING, so the default is an expression and a bare list the
// exception. Detecting a conditional render from source text (a dialog, a tab, an inline editor
// opened by `editingId === a.id`) is a real static-analysis question, so the rule is inverted: a
// form either says what it draws or writes down why it draws everything, in ALWAYS_ON_SCREEN.
export function holdersBlindToTheScreen(src: string): string[] {
  return declarations(src)
    .filter((d) => /^\s*[A-Za-z_$][\w$]*\s*$/.test(argOf(src, d.holder)))
    .map((d) => d.holder);
}

function argOf(src: string, holder: string): string {
  const m = new RegExp(`const ${holder} = useFieldRefusal\\(`).exec(src);
  return m ? argumentOf(src, m.index + m[0].length - 1) : "";
}

// A field whose control is drawn BEHIND A GUARD, declared as though it always were: the per-control
// half of the rule above. The guard is one JSX conditional in this codebase's idiom (`{expr && (`,
// `{expr ? (`) whose expression has no parens or braces, which keeps the search from walking out to
// the component body. The DECLARATION must mention the STATE the guard turns on (`type` for
// `type === "webhook"`), not repeat the condition: an inline editor's guard is `editingId === a.id`
// per row, and the holder above the rows only has `editingId`. So nothing decides implication.
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

// A reading that CANNOT run, because the `??` in front of it never falls through. `at(…)` answers
// `string | null`, so it reads naturally as the fallback of a local validation error, and it is dead
// whenever that error is a state initialized to `""` (not nullish). The other rule sees an `at(…)`
// and is satisfied, `capture` has told the caller "it is on the control", and the refusal is shown
// nowhere. The left operand is the whole test: `refusal.at(a) ?? refusal.at(b)` falls through fine.
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
// ledger above because the two rules ask different questions, and one entry answers only one: the
// agent editor's holder is a page's for the clearing rule and a hidden form's for this one.
const ALWAYS_ON_SCREEN: Record<string, string> = {
  "components/BusinessHoursForm.tsx :: refusal":
    "The schedule editor IS the screen it is on, and its four controls are drawn together. The windows and exceptions lists grow and shrink; the controls that hold them do not.",
  "pages/LoginPage.tsx :: refusal":
    "Two boxes, both always drawn. The page unmounts on a successful login, which the mounted check already answers.",
  "pages/SignupPage.tsx :: refusal": "Same two boxes, same reason.",
  "pages/settings/SettingsProfilePage.tsx :: refusal":
    "The name field is the form's only control, drawn whenever the page is.",
  "pages/resources/documents/CompanyProfileCard.tsx :: refusal":
    "The profile fields are the card's body; the card is either mounted or it is not.",
  "pages/resources/AdvancedPanel.tsx :: embRefusal":
    "One credential picker, drawn with the panel.",
  "pages/resources/AdvancedPanel.tsx :: lfRefusal":
    "The Langfuse credential picker, likewise. The enable switch hides the SETTINGS below it, not the picker this holder names.",
};

// A form that holds SOME of its refusals, with what is left. Neither rule above can see this (rule 1
// is satisfied by the hook being called at all), so it is a declaration, pinned by size. Empty, and
// kept: it is where a future form declares where it stopped, and a pin of zero makes adding one cost
// the second edit. The agent editor declares every value it writes and announces the ones held off
// screen in a banner.
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
    // A nested component's last handler must not swallow everything after it, which would read
    // a callback that awaits nothing as a write of a function declared below.
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
    // A button that sends no body at all, whose only mention of a declared name is a comment
    // inside it.
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
    // Two forms, and the one that is wrong is not the one declared first.
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
    // The shape almost every holder has, and the one an identifier-or-array reader answers `[]`
    // for, which would leave the whole check green and blind.
    const src = `
      const A = ["name", "slug"] as const;
      const r = useFieldRefusal(modal.isOpen ? A : []);
      <FormField error={r.at("name", u)} />
    `;
    expect(silentDeclarations(src)).toEqual(["r.slug"]);
  });

  test("a condition's own strings are not fields", () => {
    // `addTab === "texto"` names a tab; reading the expression's literals flat would demand a
    // control for it.
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
    // `CredentialForm` builds its list from the secret type it is drawing; an identifier-only
    // reader returns nothing for it.
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
    // No ledger under this one: the holder says which dialog it belongs to, and the ones that
    // name none are simply not asked.
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
    // Both directions, like the other ledgers here: an entry for a holder that has since
    // started answering with an expression describes code that is not there, and would go on
    // waiving whatever took its place.
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
    // of them says so once, by name, in ALWAYS_ON_SCREEN: a sentence someone wrote, not a shape a
    // regex guessed.
    const src = `
      const refusal = useFieldRefusal(BRANDING_FIELDS);
      <FormField error={refusal.at("name", v)} />
    `;
    expect(holdersBlindToTheScreen(src)).toEqual(["refusal"]);
  });

  test("an inline editor guards its readings like any dialog", () => {
    // No dialog, no tab, and the two inputs are as absent as any modal's while `editingId` is
    // null.
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
    // The path the operator uses: the deep-link path clears, the button beside it does not,
    // and the mark comes back on the value it refused.
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
