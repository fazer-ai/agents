import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expectWaiverLedger } from "@/tests/utils/ledger";
import { codeSkeleton } from "@/tests/utils/source-text";

// The guard against a handler that asks the server and then invents its own sentence. The API
// answers a refusal with a localized sentence naming the field; a fixed "could not save" throws
// away the part the operator can act on, and one that sounds SPECIFIC ("check the timezone") is
// worse. A fixed sentence is legitimate only when the toast fires BEFORE the handler talked to the
// server (a client-side check), or sits in a bare `catch {}` no `throw` of the request's error
// reaches (Eden resolves a transport failure with a `value` that has no `error` key). `catch {}`
// under `if (err || !data) throw err` is NOT that case: it receives the Eden error and drops it.

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

// The argument list of one call, from the source, without the commas that belong to something nested.
function callArgs(src: string, openParen: number): string {
  let depth = 1;
  let i = openParen + 1;
  let quote: string | null = null;
  while (i < src.length && depth > 0) {
    const c = src[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    i++;
  }
  return src.slice(openParen + 1, i - 1);
}

// Every `{` still open at `at`, innermost last. Brace-matched rather than indentation-matched: this
// tree formats at two spaces and at four, and a JSX handler nests.
// The CHAIN, not just the innermost: a toast inside `if (error || !data) { … }` sits in a block
// with no `await`, so an innermost reading would call the commonest shape a preflight. The question
// is about the HANDLER.
export function openBlocks(code: string, at: number): number[] {
  const opens: number[] = [];
  for (let i = 0; i < at; i++) {
    if (code[i] === "{") opens.push(i);
    else if (code[i] === "}") opens.pop();
  }
  return opens;
}

// Anything whose head ends in a parameter list: a declaration, a method, an arrow. The return
// annotation between `)` and `{` is why this cannot exclude parens (`function f(): Promise<string |
// null> {`); excluding them falls back to the whole component and accuses its preflights.
const FUNCTION_HEAD = /\)\s*(?::[^={}]*)?(?:=>)?\s*\{$/;
// The keyword that opens the block starting at `brace`, or "" when its head is not `<word>(…) {`.
// `\w+(args) {` is also how every control statement reads, and `if (error || !data) {` taken for the
// handler would stop the search one brace too early. Matched by PARENS, not a regex over the head:
// `[^()]*` cannot cross a nested call (`if (error && isKnown(error)) {`), and taking that `if` for
// the handler leaves the request outside, answering "no offender" silently.
export function headKeyword(code: string, brace: number): string {
  let i = brace - 1;
  while (i >= 0 && /\s/.test(code[i] as string)) i--;
  if (code[i] !== ")") return "";
  let depth = 0;
  for (; i >= 0; i--) {
    if (code[i] === ")") depth++;
    else if (code[i] === "(") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (i < 0) return "";
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j] as string)) j--;
  const end = j + 1;
  while (j >= 0 && /[\w$]/.test(code[j] as string)) j--;
  return code.slice(j + 1, end);
}

const CONTROL_WORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "catch",
  "do",
  "try",
]);

// The block that IS the handler: the innermost enclosing block whose head reads as a function, so a
// `try`, an `if` or a loop in between does not truncate the search for the request.
function enclosingHandler(
  code: string,
  chain: number[],
): { body: string; start: number } | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const start = chain[i] as number;
    if (CONTROL_WORDS.has(headKeyword(code, start))) continue;
    const head = code.slice(Math.max(0, start - 200), start + 1);
    if (FUNCTION_HEAD.test(head)) {
      return {
        body: code.slice(start, chain[chain.length - 1] as number),
        start,
      };
    }
  }
  // No enclosing function found. Unknown is not "offender": falling back to the outermost block asks
  // the question of the whole COMPONENT, which awaits somewhere for sure, and every preflight in it
  // becomes an accusation.
  return null;
}

// Does a `catch` block reach the error of the request its `try` made?
//
// Two ways: the catch binds it itself, or the try re-threw it. `throw err` is the idiom in this tree
// (`if (err || !data) throw err`), and it is the one that reads like there is nothing to show.
function catchSeesTheError(code: string, blockStart: number): boolean {
  const head = code.slice(Math.max(0, blockStart - 40), blockStart + 1);
  const bound = /catch\s*\(\s*\w+\s*\)\s*\{$/.test(head);
  if (bound) return true;
  if (!/catch\s*\{$/.test(head)) return false;
  // NOTE: the `try` this catch belongs to, brace-matched. A fixed window backwards would accept a
  // `throw err` from ANOTHER function (a local `JSON.parse` catch below a request handler) and
  // demand a fix for a refusal that does not exist.
  const tryEnd = code.lastIndexOf("}", blockStart);
  if (tryEnd < 0) return false;
  let depth = 0;
  let tryStart = -1;
  for (let i = tryEnd; i >= 0; i--) {
    if (code[i] === "}") depth++;
    else if (code[i] === "{") {
      depth--;
      if (depth === 0) {
        tryStart = i;
        break;
      }
    }
  }
  if (tryStart < 0) return false;
  return /\bthrow\s+(err|error|e)\b/.test(code.slice(tryStart, tryEnd));
}

// The expression one `await` waits on: from just after the keyword to the end of the term, brackets
// balanced. Needed because "did this handler ask the server" is a question about what is being
// awaited, and the call is not always the first thing after the keyword.
function awaitedExpression(body: string, afterKeyword: number): string {
  let depth = 0;
  let i = afterKeyword;
  for (; i < body.length; i++) {
    const c = body[i] as string;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ";" || c === ",")) break;
  }
  return body.slice(afterKeyword, i);
}

// Has this handler awaited a request, up to here? Asked of each awaited EXPRESSION, not of the text
// `await api.`, because the call is routinely not the first thing after the keyword: an endpoint
// named first (`const endpoint = api…; await endpoint.approve.post()`), or several requests at
// once (`await Promise.all([api…, api…])`). A rule over the TEXT rather than its meaning misses both.
export function talkedToTheServer(body: string): boolean {
  const aliases = [...body.matchAll(/(?:const|let)\s+(\w+)\s*=\s*api\./g)].map(
    (m) => m[1] as string,
  );
  for (const kw of body.matchAll(/\bawait\b/g)) {
    const expr = awaitedExpression(body, (kw.index as number) + "await".length);
    if (/\bapi\./.test(expr)) return true;
    if (aliases.some((name) => new RegExp(`\\b${name}\\b`).test(expr)))
      return true;
  }
  return false;
}

// The handler's own name, when it has one: `function load() {`, `const save = async () => {`,
// `const failed = useCallback(\n  (reason) => {`. Anonymous callbacks answer null, and the delegation
// question is simply not asked of them.
// Walked back as TOKENS, not matched on the line the block opens: biome wraps `useCallback(` once
// its argument has a parameter, and a one-line regex would read that as anonymous and go quiet.
function handlerName(code: string, start: number): string | null {
  let i = start - 1;
  let seen: string | null = null;
  const skipSpace = () => {
    while (i >= 0 && /\s/.test(code[i] as string)) i--;
  };
  for (let step = 0; step < 24; step++) {
    skipSpace();
    if (i < 0) return null;
    const c = code[i] as string;
    // A balanced group ending here: a parameter list, an index, an object.
    if (c === ")" || c === "]" || c === "}") {
      const open = c === ")" ? "(" : c === "]" ? "[" : "{";
      let depth = 0;
      for (; i >= 0; i--) {
        if (code[i] === c) depth++;
        else if (code[i] === open && --depth === 0) break;
      }
      i--;
      continue;
    }
    if (c === ">" && code[i - 1] === "=") {
      i -= 2; // the arrow
      continue;
    }
    // A return annotation: `function f(): Promise<string | null> {`, `function g(): boolean {`. The
    // generic form is skipped back to its colon in one go; the bare one falls through to the
    // identifier branch and lands on the colon below.
    if (c === ">") {
      while (i >= 0 && /[\w\s$.<>|&,'"[\]?]/.test(code[i] as string)) i--;
      if (code[i] !== ":") return null;
      i--;
      continue;
    }
    // `:` is the annotation's own colon. An object property (`{ onSave: () => {` ) reaches the `{`
    // one step later and answers null there, which is the abstention we want.
    if (c === "=" || c === "(" || c === ":") {
      i--;
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j >= 0 && /[\w$.]/.test(code[j] as string)) j--;
      const word = code.slice(j + 1, i + 1);
      if (["const", "let", "var", "function"].includes(word)) return seen;
      seen = word;
      i = j;
      continue;
    }
    return null;
  }
  return null;
}

// Is this handler CALLED from a place that had already asked the server? A handler that awaits
// nothing is normally a client-side check, unless the toast is delegated: `DocumentsPanel` holds the
// sentence in `const failed = useCallback(…)` and `load` calls it inside `if (list.error ||
// settings.error)`, so the refusal is at the call site. The call site is asked the SAME question,
// so a helper called from another preflight stays a preflight.
function calledAfterARequest(code: string, start: number): boolean {
  const name = handlerName(code, start);
  if (!name) return false;
  for (const call of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
    const at = call.index as number;
    // `function failed(` is the declaration, not a call, and its enclosing block is the component —
    // which awaits somewhere for sure. Without this every named helper reads as delegated.
    if (/(?:function|const|let)\s+$/.test(code.slice(Math.max(0, at - 20), at)))
      continue;
    const caller = enclosingHandler(code, openBlocks(code, at));
    if (caller && talkedToTheServer(code.slice(caller.start, at))) return true;
  }
  return false;
}

export interface Offender {
  file: string;
  line: number;
  shown: string;
}

// The `}` that closes the block opened at `start`, or -1 when it is still open at the end of `code`.
function blockEnd(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

// Would `name` being truthy, on its own, have entered this condition? True for `err` and for
// `err || anything`; false for `err && anything`, whose exit says nothing about `err`.
function entersOnItsOwn(condition: string, name: string): boolean {
  let depth = 0;
  for (let i = 0; i < condition.length; i++) {
    const c = condition[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "|" && condition[i + 1] === "|")
      return condition.slice(0, i).trim() === name;
    else if (depth === 0 && c === "&" && condition[i + 1] === "&") return false;
  }
  return condition.trim() === name;
}

// Is `name` provably falsy where this toast is raised? `apiErrorMessage(err)` reads as compliance
// from its ARGUMENT TEXT, but after `if (err || !result) { … return; }` the binding is null and the
// toast always shows the fixed sentence (`WebhooksPage.runTest` has that shape, waived below).
// The discriminator is whether the guard's block CLOSED before the toast: inside `if (err || !data)
// { … }` the binding is live, and it is the commonest shape, so getting it backwards accuses every
// correct site at once.
function bindingIsDead(body: string, name: string): boolean {
  for (const m of body.matchAll(
    new RegExp(`\\bif\\s*\\(\\s*${name}\\b`, "g"),
  )) {
    const paren = body.indexOf("(", m.index);
    let depth = 0;
    let close = -1;
    for (let i = paren; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    // NOTE: the guard has to DOMINATE the toast: nested under another condition
    // (`if (skip) { if (err) return; }`) it proves nothing about the path that skipped it. Every block
    // open at the guard must still be open at the toast; `body` ends there, so that is the whole
    // test. Getting this wrong refuses correct code.
    const atGuard = openBlocks(body, m.index);
    const atToast = openBlocks(body, body.length);
    if (!atGuard.every((b, k) => atToast[k] === b)) continue;
    // NOTE: leaving proves the binding falsy only when the binding ALONE would have entered: `if (err)` and
    // `if (err || !data)` do, `if (err && err.status === 409)` does not (its exit is compatible with
    // a truthy `err`, and the read below it is real; `AgentEditorPage.handleConflict` has that shape).
    if (!entersOnItsOwn(body.slice(paren + 1, close), name)) continue;
    let i = close + 1;
    while (i < body.length && /\s/.test(body[i] as string)) i++;
    let exits = false;
    let after = -1;
    if (body[i] === "{") {
      const end = blockEnd(body, i);
      // Still open here ⇒ the toast is INSIDE the guard, which is where the binding is live.
      if (end < 0) continue;
      // The exit has to be the guard's OWN last statement: at its brace level, and the WHOLE
      // statement. `if (err) { if (x) return; }` ends in a `return` only one path takes, and the tail
      // read as text is indistinguishable from an unconditional one — the difference is what sits
      // between the previous statement boundary and the keyword.
      const guarded = body.slice(i, end);
      const tail = /\b(return|throw)\b[^;]*;\s*$/.exec(guarded);
      const stmtStart = tail
        ? Math.max(
            guarded.lastIndexOf(";", tail.index - 1),
            guarded.lastIndexOf("{", tail.index - 1),
            guarded.lastIndexOf("}", tail.index - 1),
          )
        : -1;
      exits =
        !!tail &&
        openBlocks(guarded, tail.index).length === 1 &&
        guarded.slice(stmtStart + 1, tail.index).trim() === "";
      after = end + 1;
    } else {
      const semi = body.indexOf(";", i);
      exits = semi >= 0 && /\b(return|throw)\b/.test(body.slice(i, semi));
      after = semi + 1;
    }
    if (!exits) continue;
    // And nothing put a value back into it between the guard and the toast. `err = await retry()`
    // makes the binding live again, and the guard above says nothing about what it holds now.
    if (new RegExp(`\\b${name}\\s*=[^=]`).test(body.slice(after))) continue;
    return true;
  }
  return false;
}

// The two channels a refusal reaches the operator through, as one trigger: `showToast(…, "error")`
// and an error setter that renders the refusal INSIDE the form (an error line in a modal, a banner).
// Keying on the toast alone would miss e.g. a 409 "name already in use" shown as "check the
// URL/command". The setter is recognised by NAME: `set` + optional CamelCase middle + `Err`, then
// the call. `settingsTextError(` does not match (uppercase after `set`), nor `setUsageErrorStatus(`
// (the trailing paren excludes a name that continues past the error, here an HTTP status).
const ERROR_CHANNEL = /showToast\(|\bset(?:[A-Z]\w*)?Err(?:or)?\(/g;

// A trigger that is actually SHOWING a sentence. A toast declares its level in the second argument,
// and the trailing comma is allowed for: biome writes one on every multi-line call, and those are
// the long toasts with a sentence worth replacing. An error setter declares its level in its name,
// so every call qualifies but two shapes: `setError("")` clears, and a BOOLEAN error state drives a
// "could not load" boundary after a failed READ, with nothing to attach. A WRITE reduced to a flag
// is a different question, asked by tests/client/field-refusal-forms.test.tsx.
function showsASentence(trigger: string, args: string): boolean {
  if (trigger.startsWith("showToast")) {
    return /["']error["'],?$/.test(args.trim());
  }
  return !/^\s*(?:""|''|``|null|undefined|true|false|!!?\w[\w.]*)\s*$/.test(
    args,
  );
}

// The names in one scope that end up carrying the server's sentence, directly or through another
// name that does. A chain, not one hop: a form writes `const held = (e) => refusal.capture(…)` then
// `const toast = held(err)`. Runs to a fixed point, since the number of hops is the form's business.
function readingNames(scope: string): Set<string> {
  const names = new Set<string>();
  for (;;) {
    const before = names.size;
    for (const m of scope.matchAll(/\b([A-Za-z_$][\w$]*)\s*=([^;]*)/g)) {
      const name = m[1] as string;
      const rhs = m[2] as string;
      if (names.has(name)) continue;
      if (
        /apiErrorMessage|[Rr]efusal\./.test(rhs) ||
        [...names].some((r) => new RegExp(`\\b${r}\\s*\\(`).test(rhs))
      ) {
        names.add(name);
      }
    }
    if (names.size === before) return names;
  }
}

// Every error toast in one file, each with the verdict the rules above reach about it. One walker
// rather than two copies of the filter chain, so a rule cannot be added to one and not the other.
type Verdict =
  // the sentence is already read, or computed by name from a read
  | "reads"
  // no server sentence exists at this line: nothing sent yet, or a catch no throw reaches
  | "nothing-to-read"
  // its handler awaits nothing AND has no name, so there is no call site to put the question to
  | "unasked"
  // a fixed sentence where the server had sent one
  | "offender"
  // it calls apiErrorMessage, but on a binding a guard above has already proved falsy
  | "dead-read";

function verdicts(
  src: string,
  file: string,
): { verdict: Verdict; at: Offender }[] {
  const out: { verdict: Verdict; at: Offender }[] = [];
  // Structure is read off the skeleton and TEXT off the source: the braces have to be real code, and
  // the sentence being shown is exactly the part the skeleton blanks.
  const code = codeSkeleton(src);
  for (const m of code.matchAll(ERROR_CHANNEL)) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(src, open);
    if (!showsASentence(m[0], args)) continue;
    const at: Offender = {
      file,
      line: src.slice(0, m.index).split("\n").length,
      shown: args.replace(/\s+/g, " ").slice(0, 70),
    };
    const say = (verdict: Verdict) => out.push({ verdict, at });

    const chain = openBlocks(code, m.index);
    if (!chain.length) {
      say("nothing-to-read");
      continue;
    }

    // NOTE: `.value.error` is the same read by hand, and `mapSaveError` (CredentialForm) does it on
    // purpose: a LOCALIZED sentence for 409 and the server's own for 400. The hook is often held under
    // a qualified name (`embRefusal`, `lfRefusal`), so the capital is part of the pattern.
    // `(apiError.value as ApiErrorPayload)?.error` is the same read with a CAST; whether it is placed
    // at the input is asked by the form fence.
    if (
      /apiErrorMessage|[Rr]efusal\.|ApiErrorPayload|\.value\??\.error/.test(
        args,
      )
    ) {
      const read = args.match(/apiErrorMessage\(\s*(\w+)\s*\)/);
      const scope = enclosingHandler(code, chain);
      say(
        read &&
          scope &&
          bindingIsDead(code.slice(scope.start, m.index), read[1] as string)
          ? "dead-read"
          : "reads",
      );
      continue;
    }

    // NOTE: the sentence can be computed a few lines up and shown by NAME (`const toast =
    // refusal.capture(…)` then `showToast(toast, "error")`), or through a local helper called twice
    // (`setError(held(err))`). Every identifier in the argument list is asked, not just a leading
    // one: `held(err) ?? ""` and `msg ?? fallback` are the same question with other punctuation.
    const carriers = readingNames(src.slice(chain[0] ?? 0, m.index));
    if (
      [...args.matchAll(/\b[A-Za-z_$][\w$]*/g)].some((i) =>
        carriers.has(i[0] as string),
      )
    ) {
      say("reads");
      continue;
    }

    // The innermost enclosing `catch`, if the toast is in one at all.
    const catchStart = chain.findLast((start) =>
      /catch\s*(\(\s*\w+\s*\))?\s*\{$/.test(
        code.slice(Math.max(0, start - 40), start + 1),
      ),
    );

    if (catchStart !== undefined) {
      // A catch nothing of the request's can reach. See the header: Eden resolves transport failures,
      // so this one only ever holds a fault in our own handler.
      say(catchSeesTheError(code, catchStart) ? "offender" : "nothing-to-read");
      continue;
    }

    // A client-side check: the handler has not asked the server BEFORE this line, so no sentence of
    // its exists yet. Asked of the handler, not of the `if` the toast happens to sit in.
    const handler = enclosingHandler(code, chain);
    // NOTE: unreachable on this tree and on every fixture here (every toast sits inside some
    // function), and kept deliberately: a source scanner that meets a shape it does not understand
    // must answer "I cannot tell", not throw a null dereference in the middle of the suite.
    if (!handler) {
      say("unasked");
      continue;
    }
    if (talkedToTheServer(code.slice(handler.start, m.index))) {
      say("offender");
      continue;
    }
    // Awaits nothing itself. It is a preflight only if nobody who HAD asked the server handed it the
    // toast, and that question needs a name to ask it of.
    if (!handlerName(code, handler.start)) {
      say("unasked");
      continue;
    }
    say(
      calledAfterARequest(code, handler.start) ? "offender" : "nothing-to-read",
    );
  }
  return out;
}

// Toasts that call `apiErrorMessage` on a binding a guard above has already proved falsy. Swept in
// appearance, unswept in fact.
export function deadReads(src: string, file = "<memory>"): Offender[] {
  return verdicts(src, file)
    .filter((v) => v.verdict === "dead-read")
    .map((v) => v.at);
}

export function unreadRefusals(src: string, file = "<memory>"): Offender[] {
  return verdicts(src, file)
    .filter((v) => v.verdict === "offender")
    .map((v) => v.at);
}

// Toasts the scanner cannot ASK about: their handler awaits nothing and has no name, so there is no
// call site to put the question to. It abstains, which is the right answer and also a silent one —
// and silence is the shape every bug in this predicate has taken. Pinned below, so a new one costs an
// edit and a look rather than passing as a clean scan.
export function unaskedToasts(src: string, file = "<memory>"): Offender[] {
  return verdicts(src, file)
    .filter((v) => v.verdict === "unasked")
    .map((v) => v.at);
}

// `a || b ? c : d` is `(a || b) ? c : d`: `apiErrorMessage(err) || status === 409 ? <409 sentence>
// : <generic>` answers the 409 sentence for EVERY refusal that carries a message, a fixed sentence
// that sounds specific. Neither the compiler nor the fence above can see it (both branches are
// strings, and `apiErrorMessage` is in the argument), so it gets its own rule.
export function unparenthesisedFallback(
  src: string,
  file = "<memory>",
): string[] {
  const out: string[] = [];
  for (const m of codeSkeleton(src).matchAll(
    /apiErrorMessage\(\w+\)\s*\|\|\s*/g,
  )) {
    const tail = src.slice(m.index + m[0].length);
    let depth = 0;
    for (let i = 0; i < tail.length && i < 600; i++) {
      const c = tail[i] as string;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && c === ",") break;
      // `?.` and `??` both start with the character a ternary does, and `??` has to be excluded on
      // BOTH sides: skipping only the first of the pair leaves the second one reading as a ternary.
      else if (
        depth === 0 &&
        c === "?" &&
        tail[i + 1] !== "." &&
        tail[i + 1] !== "?" &&
        tail[i - 1] !== "?"
      ) {
        out.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
        break;
      }
    }
  }
  return out;
}

// The judgement calls: a toast raised AFTER the handler has talked to the server that is still
// correctly a fixed sentence, for a reason the source cannot state. Each one is named with why, and
// every entry is a toast about something the server did NOT refuse.
// Keyed by the SENTENCE, not the line: a line number moves on an unrelated edit, while a rewritten
// sentence SHOULD bring the waiver back for review.
const WAIVED: Record<string, string> = {
  "pages/agents/AgentEditorPage.tsx :: toolsText":
    "settingsTextError is OUR OWN preflight over the bag, run after a re-read of the stored settings. There is no refusal: the request it would have made was never sent.",
  "pages/resources/KnowledgeApprovals.tsx :: approvals.editGone":
    "A lost race reported INSIDE a 200: another reviewer got there first. The server did not refuse anything, so there is no sentence of its to show.",
  "components/GoogleOAuthSection.tsx :: vault.googleOAuth.popupBlocked":
    "The browser refused to open the popup. Nothing was sent, so there is no answer to quote.",
  "components/GoogleOAuthSection.tsx :: vault.googleOAuth.authFailed":
    "The popup's own outcome (closed, denied), which never reached our API. `outcome` is the window's, not a response.",
  "components/McpOAuthSection.tsx :: vault.mcpOAuth.popupBlocked":
    "Same as the Google section: the browser blocked the popup before any request.",
  "components/McpOAuthSection.tsx :: vault.mcpOAuth.authFailed":
    "Same as the Google section: the popup outcome, decided in the browser.",
  "components/alerts/AlertChannelsSection.tsx :: alerts.testFailedReason":
    "The alert-channel twin of the webhooks entry below, added with the Test button in #605 and waived for the identical reason: the 200 carries the DESTINATION's refusal, `err` is null by the guard above it, and `result.error` is the endpoint's own sentence. `apiErrorMessage(err)` here could only ever answer null.",
  "pages/WebhooksPage.tsx :: webhooks.testFailedReason":
    "A 200 carrying the TARGET's rejection, not a refusal of ours — same class as `approvals.editGone`. `err` is null by the guard above, and the reason shown is `result.error`, which is the endpoint's own. The sweep put `apiErrorMessage(err)` here and it could only ever answer null.",
  "pages/OAuthConsentPage.tsx :: generic":
    'This endpoint\'s only two refusals are a bare UnauthorizedError() and a bare NotFoundError() — "Unauthorized" and "Not found". The second is the ordinary case (the pending authorization expired or was consumed elsewhere), and showing it would cost the only recovery action the person has, which the server does not know about. Same class as editor.conflictToast: the client\'s sentence is the more specific one. The sentence is `oauth.consent.genericError`, held in a local so both branches show the same one.',
  "pages/LoginPage.tsx :: auth.googleSignInFailed":
    "The Google button's own `onError`: the widget failed in the browser (script blocked, popup closed, a client id the origin does not allow) and nothing of ours was sent. The scanner reads it as the page's handler because a brace-less arrow inside JSX opens no block of its own.",
  "pages/SignupPage.tsx :: auth.googleSignInFailed":
    "Same widget, same page-level reading: the failure is the button's, decided before any request of ours exists.",
  "pages/agents/AgentEditorPage.tsx :: editor.conflictToast":
    "Gated on `status === 409`, and all three 409s these routes answer are the same `errors.agentModifiedElsewhere`. The client's sentence says the same thing plus the affordance the server cannot know about — the banner's `save again to overwrite` — so passing the server's through would make the toast WORSE.",
};

// Toasts raised from an anonymous handler, where the delegation question has nowhere to go. Both are
// `useEffect(() => {` reacting to state that is already on screen, so neither has a request behind it
// — but that is a JUDGEMENT, and it is written down here rather than left to a scan that says nothing.
const UNASKED: Record<string, string> = {
  "components/TenantDeepLink.tsx :: tenant.deepLinkUnavailable":
    'An effect over the tenant list already loaded: `action.kind === "unavailable"` is decided here, and no request was made to reach it.',
  "pages/resources/VaultPanel.tsx :: vault.fillLinkNotHere":
    "An effect over `entries` already loaded. The comment above it says why a failed load says nothing instead: an empty list is not the same claim as `the tenant does not have it`.",
};

// The subject of a waiver: the file, and the first translation key or bare identifier the toast
// shows. Both spellings appear — `t("k", "…")` and a variable computed above.
export function waiverKey(o: Offender): string {
  const named =
    o.shown.match(/t\(\s*["']([\w.]+)["']/)?.[1] ??
    o.shown.match(/^(\w+)\s*,/)?.[1];
  return `${o.file.replace(`${ROOT}/`, "")} :: ${named ?? o.shown}`;
}

describe("an error toast shows what the server said", () => {
  test("the predicate flags a handler that discards the error it has", () => {
    // NOTE: the positive control, written out rather than trusted to the tree: the real scan finds
    // nothing, and a predicate that matched NOTHING would pass that assertion exactly as well.
    const offending = `
      async function save() {
        const { data, error } = await api.api.v1.things.post(body);
        if (error || !data) {
          showToast(t("x.saveError", "Could not save."), "error");
          return;
        }
      }`;
    expect(unreadRefusals(offending).length).toBe(1);
  });

  test("the predicate flags a bare catch that a throw reaches", () => {
    // The shape that reads as if there were nothing to show. There is: `throw err` put the Eden
    // error object into the catch, and the binding is where it was dropped.
    const rethrown = `
      async function save() {
        try {
          const { data, error: err } = await api.api.v1.things.post(body);
          if (err || !data) throw err;
        } catch {
          showToast(t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(unreadRefusals(rethrown).length).toBe(1);
  });

  test("a bare catch with nothing thrown into it is not an offender", () => {
    // NOTE: Eden resolves a transport failure rather than rejecting, so this catch holds only a fault
    // in our own handler, and `apiErrorMessage` would answer null for it anyway.
    const ownFault = `
      async function save() {
        try {
          const { data } = await api.api.v1.things.post(body);
          render(data);
        } catch {
          showToast(t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(unreadRefusals(ownFault)).toEqual([]);
  });

  test("an endpoint named before it is awaited still counts as a request", () => {
    // NOTE: the alias shape, verbatim from `KnowledgeApprovals.act`: reading `await api.` as literal
    // text would call this handler "never talked to the server".
    const aliased = `
      async function act(id) {
        try {
          const endpoint = api.api.v1.knowledge.approvals({ id });
          const { error: err } = await endpoint.approve.post();
          if (err) {
            showToast(t("approvals.actionError", "Action failed."), "error");
          }
        } catch {}
      }`;
    expect(unreadRefusals(aliased).length).toBe(1);
  });

  test("a check that runs before the request is not an offender", () => {
    const preflight = `
      async function save() {
        if (!name.trim()) {
          showToast(t("x.nameRequired", "Name is required."), "error");
          return;
        }
        const { data } = await api.api.v1.things.post(body);
        render(data);
      }`;
    expect(unreadRefusals(preflight)).toEqual([]);
  });

  test("a toast the formatter wrapped is still read", () => {
    // NOTE: biome writes a trailing comma on every multi-line call, so requiring the `"error"` to be
    // LAST would skip every long toast, the ones with a sentence worth replacing.
    const wrapped = `
      async function save() {
        const { data, error } = await api.api.v1.things.post(body);
        if (error || !data) {
          showToast(
            t("x.saveError", "Could not save."),
            "error",
          );
        }
      }`;
    expect(unreadRefusals(wrapped).length).toBe(1);
  });

  test("a comment full of braces does not move the block boundaries", () => {
    // This tree's comments are prose about code: `{ error }`, `{{placeholder}}`, `${…}`. Counting
    // braces on the raw text lets ONE unbalanced comment shift every boundary after it, and the scan
    // then answers about the wrong function for the rest of the file, silently.
    const commented = `
      async function save() {
        // The body is \`{ data, error }\` and the catch takes what the throw put in it: }
        const { data, error } = await api.api.v1.things.post(body);
        if (error || !data) {
          showToast(t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(unreadRefusals(commented).length).toBe(1);
  });

  test("a return annotation does not hide the function", () => {
    // NOTE: `function f(): Promise<string | null> {` has parens in its head, so a pattern that
    // excluded them would read "no function here", fall back to the whole component, and accuse
    // preflights because something ELSE in that component awaited.
    const annotated = `
      async function ensureSaved(): Promise<string | null> {
        if (!name) {
          showToast(t("x.nameRequired", "Name is required."), "error");
          return null;
        }
        const { data } = await api.api.v1.things.post(body);
        return data.id;
      }`;
    expect(unreadRefusals(annotated)).toEqual([]);
  });

  test("a nested call in an `if` head does not make it the handler", () => {
    // NOTE: `if (error && isKnown(error)) {` reads as `<word>(…) {` just like a function head, and
    // `[^()]*` stops at the inner call's paren. Taking the `if` for the handler would put the request
    // OUTSIDE the searched body and answer "never talked to the server", silently.
    const nested = `
      async function save() {
        const { data, error } = await api.api.v1.things.post(body);
        if (error && isKnown(error)) {
          showToast(t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(unreadRefusals(nested).length).toBe(1);
  });

  test("a throw in another function does not feed this catch", () => {
    // NOTE: the `try` a bare catch belongs to is brace-matched, not a fixed window backwards: with a
    // window, an earlier `throw err` anywhere in the file would count, and a local `JSON.parse` catch
    // would be read as holding a server refusal.
    const elsewhere = `
      async function save() {
        const { data, error: err } = await api.api.v1.things.post(body);
        if (err || !data) throw err;
        render(data);
      }

      function parseLocal(raw) {
        try {
          return JSON.parse(raw);
        } catch {
          showToast(t("x.parseError", "Could not read the file."), "error");
          return null;
        }
      }`;
    expect(unreadRefusals(elsewhere)).toEqual([]);
  });

  test("four requests awaited at once still count as a request", () => {
    // NOTE: `src/client` loads screens with `await Promise.all([api…, api…])`, and reading
    // `await api.` as literal text would answer "never talked to the server" about every one.
    const batched = `
      async function load() {
        const [list, settings] = await Promise.all([
          api.api.v1.things.get(),
          api.api.v1["tenant-settings"].get(),
        ]);
        if (list.error || settings.error) {
          showToast(t("x.refreshError", "Could not refresh."), "error");
        }
      }`;
    expect(unreadRefusals(batched).length).toBe(1);
  });

  test("a toast delegated to a helper is asked about its caller", () => {
    // NOTE: verbatim in shape from `DocumentsPanel`: the sentence lives in a `useCallback` that
    // awaits nothing, and the refusal is at the call site. Asked on its own the helper looks like a
    // preflight.
    const delegated = `
      const failed = useCallback(() => {
        showToast(t("x.refreshError", "Could not refresh."), "error");
      }, [showToast, t]);
      const load = useCallback(async () => {
        const [list] = await Promise.all([api.api.v1.things.get()]);
        if (list.error) {
          failed();
          return;
        }
      }, [failed]);`;
    expect(unreadRefusals(delegated).length).toBe(1);
  });

  test("a wrapped `useCallback(` still names its handler", () => {
    // NOTE: the production shape, as a fixture of its own: biome wraps `useCallback(` once its
    // argument grows a parameter, and reading the name off the line the block opens would answer
    // "anonymous", so the delegation question would never be asked.
    const wrapped = `
      const failed = useCallback(
        (reason?: unknown) => {
          showToast(t("x.refreshError", "Could not refresh."), "error");
        },
        [showToast, t],
      );
      const load = useCallback(async () => {
        const [list] = await Promise.all([api.api.v1.things.get()]);
        if (list.error) {
          failed(list.error);
          return;
        }
      }, [failed]);`;
    expect(unreadRefusals(wrapped).length).toBe(1);
  });

  test("a helper called from a preflight stays a preflight", () => {
    // The call site is asked the SAME question, so delegation does not turn every shared toast into
    // an accusation. Without this control the rule above is a blanket one, and the ledger grows to
    // hold sentences that are correct as they are.
    const shared = `
      const complain = useCallback(() => {
        showToast(t("x.nameRequired", "Name is required."), "error");
      }, [showToast, t]);
      const save = useCallback(async () => {
        if (!name.trim()) {
          complain();
          return;
        }
        await api.api.v1.things.post(body);
      }, [complain]);`;
    expect(unreadRefusals(shared)).toEqual([]);
  });

  test("a read of a binding the guard already killed is not a read", () => {
    // NOTE: the rule's own idiom applied one branch too far, verbatim from `WebhooksPage.runTest`:
    // the guard proves `err` null and returns, and the branch below reads it again. It looks swept
    // and shows the fixed sentence for every refusal.
    const dead = `
      async function runTest() {
        const { data, error: err } = await api.api.v1.things.test.post();
        const result = data?.result;
        if (err || !result) {
          showToast(apiErrorMessage(err) || t("x.failed", "Failed."), "error");
          return;
        }
        if (!result.ok) {
          showToast(apiErrorMessage(err) || t("x.failedReason", "Failed."), "error");
        }
      }`;
    expect(deadReads(dead).map((o) => o.line)).toEqual([10]);
  });

  test("a read inside the guard that proved it is a live read", () => {
    // The discriminator, and the direction that matters: a toast INSIDE `if (err || !data) { … }` is
    // exactly where the binding is live, and it is the commonest shape in this tree. Getting this
    // backwards accuses every correct site at once.
    const live = `
      async function save() {
        const { data, error: err } = await api.api.v1.things.post(body);
        if (err || !data) {
          showToast(apiErrorMessage(err) || t("x.saveError", "Could not save."), "error");
          return;
        }
      }`;
    expect(deadReads(live)).toEqual([]);
  });

  test("a guard nested under another condition proves nothing", () => {
    // `if (skip) { if (err) return; }` never ran on the path where `skip` was false, so `err` is as
    // live below it as it was above. The guard has to dominate the toast, not merely precede it.
    const nested = `
      async function save() {
        const { data, error: err } = await api.api.v1.things.post(body);
        if (skip) {
          if (err) return;
        }
        if (err || !data) {
          showToast(apiErrorMessage(err) || t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(deadReads(nested)).toEqual([]);
  });

  test("a guard whose exit is itself conditional proves nothing", () => {
    // `if (err) { if (fatal) return; }` ends in a `return` that only one path takes. Read as text the
    // tail looks identical to an unconditional exit; the difference is the brace level it sits at.
    const conditional = `
      async function save() {
        const { data, error: err } = await api.api.v1.things.post(body);
        if (err) {
          if (fatal) return;
        }
        if (err || !data) {
          showToast(apiErrorMessage(err) || t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(deadReads(conditional)).toEqual([]);
  });

  test("a binding written again after the guard is live again", () => {
    // The guard proved the OLD value null. `err = …` below it makes the read real, and no amount of
    // looking at the guard can see that.
    const rewritten = `
      async function save() {
        let { data, error: err } = await api.api.v1.things.post(body);
        if (err) return;
        ({ data, error: err } = await api.api.v1.things.confirm.post());
        err = err ?? null;
        if (err || !data) {
          showToast(apiErrorMessage(err) || t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(deadReads(rewritten)).toEqual([]);
  });

  test("a guard with a second condition proves nothing", () => {
    // NOTE: `if (err && err.status === 409) return;` exits on ONE kind of error and leaves every
    // other kind truthy below it. A rule matching any condition starting with the binding would
    // call that read dead and refuse correct code (`AgentEditorPage.handleConflict` has this shape).
    const partial = `
      async function save() {
        const { data, error: err } = await api.api.v1.things.post(body);
        if (err && err.status === 409) {
          setStale(true);
          return;
        }
        if (err || !data) {
          showToast(apiErrorMessage(err) || t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(deadReads(partial)).toEqual([]);
  });

  test("a guard that does not leave keeps the binding live", () => {
    // The other half of the discriminator. `if (err) { … }` without a `return` proves nothing about
    // `err` below it, so the read there is a real one. Without this control the rule reads "any
    // earlier `if (err)` kills the binding", which is how a fence starts refusing correct code.
    const kept = `
      async function save() {
        const { data, error: err } = await api.api.v1.things.post(body);
        if (err) {
          setBanner(true);
        }
        if (!data) {
          showToast(apiErrorMessage(err) || t("x.saveError", "Could not save."), "error");
        }
      }`;
    expect(deadReads(kept)).toEqual([]);
  });

  test("a sentence computed by a local helper is a read", () => {
    // NOTE: the shape a form with two failure branches reaches for: one helper, called from the
    // resolved branch and from the catch. Neither call site mentions the read, so the fence has to
    // follow the name to find it.
    const src = `
      async function save() {
        const held = (e: unknown) =>
          refusal.capture(e, t("x", "Could not save."), sent, current) ?? "";
        try {
          const { error } = await api.thing.post(body);
          if (error) {
            setError(held(error));
            return;
          }
        } catch (e) {
          setError(held(e));
        }
      }
    `;
    expect(unreadRefusals(src)).toEqual([]);
  });

  test("a sentence carried through two names is still a read", () => {
    // The shape the vault form reaches for: a helper that captures, and a `toast` holding what the
    // helper answered. Following one hop stops at `toast` and calls this an offender.
    const src = `
      async function save() {
        const held = (e: unknown, sent: Record<string, unknown>) =>
          refusal.capture(e, fallback, sent, current);
        const { error } = await api.thing.post(body);
        if (error) {
          const toast = held(error, body);
          if (toast) showToast(toast, "error");
          return;
        }
      }
    `;
    expect(unreadRefusals(src)).toEqual([]);
  });

  test("an unrelated local name does not make a fixed sentence a read", () => {
    // NOTE: the other direction of following names: the handler DOES read the sentence, somewhere, and
    // then shows a fixed one anyway. Asking "is any identifier in this call assigned from a read"
    // has to answer about the identifiers of THIS call.
    const src = `
      async function save() {
        const reason = apiErrorMessage(err);
        const { error } = await api.thing.post(body);
        if (error) {
          setError(t("x", "Could not save."));
          return;
        }
        log(reason);
      }
    `;
    expect(unreadRefusals(src)).toHaveLength(1);
  });

  test("a handler that reads the sentence is not an offender", () => {
    const reads = `
      async function save() {
        const { data, error } = await api.api.v1.things.post(body);
        if (error || !data) {
          showToast(apiErrorMessage(error) || t("x.saveError", "Could not save."), "error");
          return;
        }
      }`;
    expect(unreadRefusals(reads)).toEqual([]);
  });

  test("every error toast the server could have worded reads what it said", () => {
    const offenders = sources(ROOT)
      .flatMap((f) => unreadRefusals(readFileSync(f, "utf8"), f))
      .filter((o) => !(waiverKey(o) in WAIVED));
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.shown}`),
      "these raise a fixed sentence where the server sent one: pass it through apiErrorMessage",
    ).toEqual([]);
  });

  test("a ternary fallback without parentheses is flagged", () => {
    // NOTE: the positive control for the rule below, in the shape it is about.
    const broken = `showToast(
      apiErrorMessage(err) || status === 409 ? t("a", "A") : t("b", "B"),
      "error",
    );`;
    expect(unparenthesisedFallback(broken).length).toBe(1);
  });

  test("the same fallback with parentheses is not", () => {
    const fixed = `showToast(
      apiErrorMessage(err) || (status === 409 ? t("a", "A") : t("b", "B")),
      "error",
    );`;
    expect(unparenthesisedFallback(fixed)).toEqual([]);
  });

  test("optional chaining and nullish coalescing are not ternaries", () => {
    // `||` cannot be mixed with `??` without parentheses at all, so the pair under test is the one
    // that does occur: optional chaining on the left, another `||` after it.
    const fine = `showToast(apiErrorMessage(err) || other?.msg || t("b", "B"), "error");`;
    expect(unparenthesisedFallback(fine)).toEqual([]);
  });

  test("a ternary after the call is not this call's fallback", () => {
    // The scan stops at the argument's own comma. Without that it runs on into the NEXT argument and
    // reports its ternary as this fallback's — and a `?` after a top-level comma is still inside the
    // call, so no closing paren stops it first.
    const later = `showToast(apiErrorMessage(err) || t("b", "B"), tone ? "error" : "info");`;
    expect(unparenthesisedFallback(later)).toEqual([]);
  });

  test("no fallback swallows its own ternary", () => {
    const offenders = sources(ROOT).flatMap((f) =>
      unparenthesisedFallback(readFileSync(f, "utf8"), f),
    );
    expect(
      offenders,
      "`a || b ? c : d` binds as `(a || b) ? c : d`: wrap the fallback ternary in parentheses",
    ).toEqual([]);
  });

  // NOTE: the ledger may only shrink, and its size is the anchor the tree cannot supply: appending a name
  // silences a new offender AND satisfies every other rule here. A raise is tolerated only for a
  // SECOND MEMBER of a class already waived (the alert-channel Test button beside the webhooks one,
  // like the `popupBlocked`/`authFailed`/`googleSignInFailed` pairs). Extracting the two pages'
  // shared handler would only relocate the `t(...)` sentences to the call sites.
  test("the waiver ledger is pinned to its size", () => {
    expectWaiverLedger("WAIVED", WAIVED, 12);
  });

  test("every toast the scanner cannot ask about is named", () => {
    const unasked = sources(ROOT).flatMap((f) =>
      unaskedToasts(readFileSync(f, "utf8"), f),
    );
    expect(
      unasked.map(waiverKey).sort(),
      "the scanner abstains on these because their handler is anonymous: name the handler, or add it here with its reason",
    ).toEqual(Object.keys(UNASKED).sort());
  });

  test("the abstention ledger is pinned to its size", () => {
    expectWaiverLedger("UNASKED", UNASKED, 2);
  });

  test("no toast reads a binding a guard above already killed", () => {
    const dead = sources(ROOT).flatMap((f) =>
      deadReads(readFileSync(f, "utf8"), f),
    );
    expect(
      dead.map((o) => `${o.file}:${o.line}  ${o.shown}`),
      "`apiErrorMessage` here is called on a binding the guard above proved falsy: it always answers null and the fixed sentence always wins",
    ).toEqual([]);
  });
});
