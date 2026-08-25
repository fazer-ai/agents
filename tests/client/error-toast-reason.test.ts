import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// THE GUARD AGAINST THE NEXT HANDLER THAT ASKS THE SERVER AND THEN INVENTS ITS OWN SENTENCE.
//
// The API answers a refusal with a sentence already localized for the request's Accept-Language, and
// since #231 with the field it is about. A handler that catches that and shows "could not save"
// throws away the only part the operator can act on — and a fixed sentence that sounds SPECIFIC is
// worse than one that does not: `hours.saveError` said "Could not save (check the timezone)" for
// every refusal the business-hours write can answer, duplicate name included.
//
// Measured before this sweep: 112 error toasts, 10 of them reading the server's sentence.
//
// What counts as an offender is a rule and not a list, because the two legitimate reasons to show a
// fixed sentence are both derivable from the source:
//
//   - the toast fires BEFORE the handler has talked to the server, so it is a client-side check
//     (an empty name, an unparseable file) and there is no server sentence in existence yet;
//   - the toast is in a bare `catch {}` that no `throw` of the request's error can reach. Measured:
//     Eden does NOT reject on a transport failure, it resolves with `{ status: 503, value: { message,
//     line, column, sourceURL } }` — a `value` with no `error` key. So such a catch sees only a fault
//     in our own handler, and there is nothing of the server's to show.
//
// Everything else is an offender, including the shape that reads as if it were the second case and is
// not: `catch {}` sitting under `if (err || !data) throw err`, which receives the Eden error object
// and discards it at the binding.

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

// The source with every comment and every string body blanked to spaces, offsets preserved.
//
// Counting braces on the raw text drifts, and it drifts SILENTLY: this tree's comments are prose
// about the code and full of `{ error }`, `{{placeholder}}` and `${…}`. One unbalanced brace inside
// one comment shifts every block boundary after it, and the scan then answers about the wrong
// function for the rest of the file. Measured: on the raw text the scan found 28 offenders and
// missed `BusinessHoursForm.tsx:230`, which is a bare `catch {}` under `throw err` read by hand.
export function codeSkeleton(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i] as string;
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "\\") k += 2;
        else if (src[k] === quote) break;
        else k++;
      }
      blank(i + 1, k);
      i = k + 1;
    } else i++;
  }
  return out.join("");
}

// Every `{` still open at `at`, innermost last. Brace-matched rather than indentation-matched: this
// tree formats at two spaces and at four, and a JSX handler nests.
//
// The CHAIN and not just the innermost, and the positive control below is what forced that: a toast
// inside `if (error || !data) { … }` sits in a block that contains no `await` at all, so an innermost
// reading answers "this handler never talked to the server" about the single commonest shape there
// is. The question is about the HANDLER, so it has to be asked of the handler.
export function openBlocks(code: string, at: number): number[] {
  const opens: number[] = [];
  for (let i = 0; i < at; i++) {
    if (code[i] === "{") opens.push(i);
    else if (code[i] === "}") opens.pop();
  }
  return opens;
}

// Anything whose head ends in a parameter list: a declaration, a method, an arrow. The annotation
// between the `)` and the `{` is why this cannot exclude parens — `function ensureSavedForConnect():
// Promise<string | null> {` was read as "no function here", the search fell back to the whole
// component body, and two client-side preflights were accused because something ELSE in the
// component awaited.
const FUNCTION_HEAD = /\)\s*(?::[^={}]*)?(?:=>)?\s*\{$/;
// The keyword that opens the block starting at `brace`, or "" when its head is not `<word>(…) {`.
//
// `\w+(args) {` is also how every control statement reads, and treating `if (error || !data) {` as
// the handler is what the first positive control caught: the search for the request stopped one brace
// too early and answered "this handler never talked to the server" about the commonest shape there
// is.
//
// Matched by PARENS and not by a regex over the head, because `[^()]*` cannot cross a nested call:
// `if (error && isKnown(error)) {` failed the control test while `FUNCTION_HEAD` matched its trailing
// `) {`, so the `if` was taken for the handler, the request above it fell outside, and the scan
// answered "no offender". Blindness, which is the direction that passes silently.
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
  // The `try` this catch belongs to, brace-matched. A fixed window backwards instead accepted a
  // `throw err` from ANOTHER function entirely: a local `JSON.parse` catch two functions below a
  // request handler was read as receiving a server error, and the tree scan then demanded a fix for a
  // refusal that does not exist.
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

// Has this handler awaited a request, up to here?
//
// Asked of each awaited EXPRESSION, not of the text `await api.`, because the call is routinely not
// the first thing after the keyword. Two shapes in this tree, and reading the literal text missed
// both:
//
//   - the endpoint named first — `KnowledgeApprovals.act` writes `const endpoint =
//     api.api.v1.knowledge.approvals({ id })` and awaits `endpoint.approve.post()`. The fence passed
//     while that handler discarded its `err` in a fixed "Action failed.";
//   - four requests at once — `DocumentsPanel.load` awaits `Promise.all([api…, api…, api…, api…])`,
//     and ten files in `src/client` load a screen that way.
//
// It is the same shape as every other bug this predicate has had: a rule stated over the TEXT rather
// than over what the text means.
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
//
// Walked back as TOKENS, not matched on the line the block opens. A one-line regex read the
// production shape as anonymous, because biome wraps `useCallback(` the moment its argument grows a
// parameter — which is exactly what the fix for `DocumentsPanel` made it do. The conservative
// direction of that miss is the dangerous one: the fence went quiet about the site it had just been
// taught to see, and reverting the fix produced no offender at all. Found by review.
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

// Is this handler CALLED from a place that had already asked the server?
//
// A handler that never awaits anything is normally a client-side check, and that is what the rule
// above assumes. It stops being true the moment the toast is delegated: `DocumentsPanel` writes
// `const failed = useCallback(…)` holding the sentence, and `load` calls it from inside
// `if (list.error || settings.error)` — the refusal is right there at the call site, and the helper,
// asked on its own, looks like a preflight. Found by review; the fence claimed an invariant it was
// not enforcing, which is the only kind of hole in a fence that matters.
//
// The call site is asked the SAME question, so a helper called from another preflight stays a
// preflight. On this tree exactly one toast changes hands, and it is the one above.
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

// Is `name` provably falsy where this toast is raised?
//
// `apiErrorMessage(err)` reads as compliance, and the fence took it as such — from the ARGUMENT TEXT,
// which says nothing about whether the argument can still hold anything. This sweep put one of those
// in by hand: `WebhooksPage.runTest` guards with `if (err || !result) { … return; }` and then reads
// `err` again in the branch below, where the guard has proved it null. The toast looked swept and
// showed the fixed sentence for every refusal, which is the defect this issue is about wearing the
// costume of the fix for it. Found by review.
//
// The discriminator is whether the guard's block CLOSED before the toast: a toast inside
// `if (err || !data) { … }` is exactly where the binding is live, and it is also the commonest shape
// in this tree, so getting that backwards would accuse every correct site at once.
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
    // The guard has to DOMINATE the toast: nested under another condition
    // (`if (skip) { if (err) return; }`) it proves nothing about the path that skipped it. Every block
    // open at the guard must still be open at the toast — `body` ends there, so that is the whole
    // test. Second rule in a row pointing outward, and the direction that refuses correct code.
    const atGuard = openBlocks(body, m.index);
    const atToast = openBlocks(body, body.length);
    if (!atGuard.every((b, k) => atToast[k] === b)) continue;
    // Leaving proves the binding falsy only when the binding ALONE would have entered: `if (err)` and
    // `if (err || !data)` do, `if (err && err.status === 409)` does not — its exit is compatible with
    // a truthy `err`, and the read below it is real. One such guard on this tree
    // (`AgentEditorPage.handleConflict`), so this is a rule about correctness, not a count.
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

// Every error toast in one file, each with the verdict the rules above reach about it. One walker
// rather than two: the filter chain was copied once, and a rule added to one copy and not the other
// is how a fence starts claiming an invariant it does not hold — which is the defect this whole file
// is a guard against.
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
  for (const m of code.matchAll(/showToast\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(src, open);
    // The trailing comma is not optional to allow for: biome writes one on every multi-line call, and
    // requiring the quote to be last silently skipped every toast the formatter had wrapped — which
    // is most of the long ones, and they are the ones with a sentence worth replacing.
    if (!/["']error["'],?$/.test(args.trim())) continue;
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

    // `.value.error` is the same read by hand, and one screen does it on purpose: `mapSaveError`
    // (CredentialForm) answers a LOCALIZED sentence for 409 and the server's own for 400, which is a
    // policy, not an oversight. A fence that only knows the helper's name calls that an offender and
    // the sweep then overrides the 409 branch.
    if (/apiErrorMessage|refusal\.|\.value\??\.error/.test(args)) {
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

    // The sentence can be computed a few lines up and shown by name — `const toast =
    // refusal.capture(…)` then `showToast(toast, "error")`. Reading only the argument list calls that
    // handler an offender while it is the reference implementation of the rule.
    const named = args.trim().match(/^(\w+)\s*(?:\?\?[^,]*)?,/);
    if (named) {
      const assigned = new RegExp(
        `\\b${named[1]}\\b\\s*=[^;]*(?:apiErrorMessage|refusal\\.)`,
      );
      if (assigned.test(src.slice(chain[0] ?? 0, m.index))) {
        say("reads");
        continue;
      }
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
    // NOTE: unreachable on this tree and on every fixture here — every toast sits inside some
    // function — and kept anyway, deliberately: a source scanner that meets a shape it does not
    // understand must answer "I cannot tell", not throw a null dereference in the middle of the
    // suite. Mutation-surviving on purpose; the alternative is a crash instead of an abstention.
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

// `a || b ? c : d` is `(a || b) ? c : d`, and that is how the sweep for this issue broke the one
// call site whose fallback was a ternary: `apiErrorMessage(err) || status === 409 ? <409 sentence> :
// <generic>` answered the 409 sentence for EVERY refusal that carried a message. It is the defect
// this whole issue is about — a fixed sentence that sounds specific — reintroduced by the fix for it.
//
// Neither the compiler nor the fence above can see it: both branches are strings, and
// `apiErrorMessage` is right there in the argument. So it gets its own rule.
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
// correctly a fixed sentence, for a reason the source cannot state. Each one is named with why.
//
// Not a place to put a handler you did not get to. Every entry here is a toast about something the
// server did NOT refuse.
//
// Keyed by the SENTENCE and not by the line. A line number is a fact about the rest of the file:
// adding one import to `GoogleOAuthSection` moved four waivers by two lines each and un-waived all of
// them at once. The sentence is what the waiver is actually about, and when someone rewrites it the
// waiver SHOULD come back for review — a key that rots on an unrelated edit is noise, one that rots
// when the subject changes is the point.
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
  "pages/WebhooksPage.tsx :: webhooks.testFailedReason":
    "A 200 carrying the TARGET's rejection, not a refusal of ours — same class as `approvals.editGone`. `err` is null by the guard above, and the reason shown is `result.error`, which is the endpoint's own. The sweep put `apiErrorMessage(err)` here and it could only ever answer null.",
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
    // The positive control, and the reason it is written out rather than trusted to the tree: after
    // this sweep the real scan finds nothing, and a predicate that matched NOTHING would pass that
    // assertion exactly as well as one that works.
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
    // Measured: Eden resolves a transport failure rather than rejecting, so this catch holds only a
    // fault in our own handler, and `apiErrorMessage` would answer null for it anyway.
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
    // The alias shape, verbatim from `KnowledgeApprovals.act`. Reading `await api.` as literal text
    // called this handler "never talked to the server" and let it discard its error.
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
    // biome writes a trailing comma on every multi-line call, so requiring the `"error"` to be LAST
    // skipped every long toast — and the long ones are the ones with a sentence worth replacing.
    // Measured: that alone hid 50 of the 67.
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
    // `function f(): Promise<string | null> {` has parens in its head, so a pattern that excluded
    // them read "no function here", fell back to the whole component, and accused two preflights
    // because something ELSE in that component awaited.
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
    // `if (error && isKnown(error)) {` reads as `<word>(…) {` just like a function head does, and a
    // regex over the head cannot tell them apart: `[^()]*` stops at the inner call's paren. The `if`
    // was then taken for the handler, the request above it fell OUTSIDE the body being searched, and
    // the scan answered "never talked to the server" — blindness, which is the direction that passes
    // in silence.
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
    // The `try` a bare catch belongs to is brace-matched, not a fixed window backwards. With a
    // window, any earlier `throw err` in the file counted: a local `JSON.parse` catch was read as
    // holding a server refusal, and the tree scan demanded a fix for a sentence that cannot exist.
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
    // Ten files in `src/client` load a screen with `await Promise.all([api…, api…])`, and reading
    // `await api.` as literal text answered "never talked to the server" about every one of them.
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
    // Verbatim in shape from `DocumentsPanel`: the sentence lives in a `useCallback` that awaits
    // nothing, and the refusal is at the call site. Asked on its own the helper looks like a
    // preflight, which is how it passed a fence that claims exactly this invariant.
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
    // The production shape, and the reason it is a fixture of its own: biome wraps `useCallback(` the
    // moment its argument grows a parameter, which is exactly what the fix for `DocumentsPanel` made
    // it do. Reading the name off the line the block opens then answered "anonymous", the delegation
    // question was never asked, and the fence went quiet about the site it had just been taught to
    // see. Measured by reverting the fix: zero offenders, with and without it.
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
    // The sweep's own idiom applied one branch too far, verbatim from `WebhooksPage.runTest`: the
    // guard proves `err` null and returns, and the branch below reads it again. It looks swept and
    // shows the fixed sentence for every refusal — the defect this issue is about, wearing the
    // costume of the fix for it.
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
    // `if (err && err.status === 409) return;` exits on ONE kind of error and leaves every other kind
    // truthy below it. A rule that matched any condition starting with the binding called that read
    // dead and would have refused correct code — the direction that shouts instead of going quiet,
    // and the only one of this predicate's bugs to point that way. The shape is real:
    // `AgentEditorPage.handleConflict` is exactly it.
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
    // The positive control for the rule below, and the shape it is about, verbatim from the sweep.
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

  // The ledger may only shrink, and its size is the anchor the tree cannot supply: appending a name
  // silences a new offender AND satisfies every other rule here.
  test("the waiver ledger is pinned to its size", () => {
    expectWaiverLedger("WAIVED", WAIVED, 8);
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
