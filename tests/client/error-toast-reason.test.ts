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
// `\w+(args) {` is also how every control statement reads, and treating `if (error || !data) {` as
// the handler is what the positive control caught: the search for the request stopped one brace too
// early and answered "this handler never talked to the server" about the commonest shape there is.
const CONTROL_HEAD =
  /\b(if|else|for|while|switch|catch|do|try)\s*(\([^()]*\))?\s*\{$/;

// The block that IS the handler: the innermost enclosing block whose head reads as a function, so a
// `try`, an `if` or a loop in between does not truncate the search for the request.
function enclosingHandler(
  src: string,
  chain: number[],
): { body: string; start: number } | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const start = chain[i] as number;
    const head = src.slice(Math.max(0, start - 200), start + 1);
    if (CONTROL_HEAD.test(head)) continue;
    if (FUNCTION_HEAD.test(head)) {
      return {
        body: src.slice(start, chain[chain.length - 1] as number),
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
function catchSeesTheError(src: string, blockStart: number): boolean {
  const head = src.slice(Math.max(0, blockStart - 40), blockStart + 1);
  const bound = /catch\s*\(\s*\w+\s*\)\s*\{$/.test(head);
  if (bound) return true;
  if (!/catch\s*\{$/.test(head)) return false;
  // The `try` this catch belongs to: the block that ends where the catch begins.
  const before = src.slice(0, blockStart);
  const tryEnd = before.lastIndexOf("}");
  if (tryEnd < 0) return false;
  return /\bthrow\s+(err|error|e)\b/.test(
    before.slice(Math.max(0, tryEnd - 3000), tryEnd),
  );
}

// Has this handler awaited a request, up to here?
//
// Not `await api.` as literal text: a handler is free to name the endpoint first, and one does —
// `KnowledgeApprovals.act` writes `const endpoint = api.api.v1.knowledge.approvals({ id })` and then
// awaits `endpoint.approve.post()`. Reading only the literal call let the fence pass while that
// handler discarded its `err` in a fixed "Action failed.", which is the invariant this file claims to
// hold. Found by review, and it is the same shape as every other bug this predicate has had: a rule
// stated over the TEXT rather than over what the text means.
export function talkedToTheServer(body: string): boolean {
  if (/await\s+api\./.test(body)) return true;
  // Anything named from `api.` in this handler, then awaited under that name.
  const aliases = [...body.matchAll(/(?:const|let)\s+(\w+)\s*=\s*api\./g)].map(
    (m) => m[1],
  );
  return aliases.some((name) => new RegExp(`await\\s+${name}\\b`).test(body));
}

export interface Offender {
  file: string;
  line: number;
  shown: string;
}

export function unreadRefusals(src: string, file = "<memory>"): Offender[] {
  const out: Offender[] = [];
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
    // `.value.error` is the same read by hand, and one screen does it on purpose: `mapSaveError`
    // (CredentialForm) answers a LOCALIZED sentence for 409 and the server's own for 400, which is a
    // policy, not an oversight. A fence that only knows the helper's name calls that an offender and
    // the sweep then overrides the 409 branch.
    if (/apiErrorMessage|refusal\.|\.value\??\.error/.test(args)) continue;
    // The sentence can be computed a few lines up and shown by name — `const toast =
    // refusal.capture(…)` then `showToast(toast, "error")`. Reading only the argument list calls that
    // handler an offender while it is the reference implementation of the rule.
    const named = args.trim().match(/^(\w+)\s*(?:\?\?[^,]*)?,/);
    if (named) {
      const chainForName = openBlocks(code, m.index);
      const from = chainForName[0] ?? 0;
      const assigned = new RegExp(
        `\\b${named[1]}\\b\\s*=[^;]*(?:apiErrorMessage|refusal\\.)`,
      );
      if (assigned.test(src.slice(from, m.index))) continue;
    }

    const chain = openBlocks(code, m.index);
    if (!chain.length) continue;

    // The innermost enclosing `catch`, if the toast is in one at all.
    const catchStart = chain.findLast((start) =>
      /catch\s*(\(\s*\w+\s*\))?\s*\{$/.test(
        code.slice(Math.max(0, start - 40), start + 1),
      ),
    );

    if (catchStart !== undefined) {
      // A catch nothing of the request's can reach. See the header: Eden resolves transport failures,
      // so this one only ever holds a fault in our own handler.
      if (!catchSeesTheError(code, catchStart)) continue;
    } else {
      // A client-side check: the handler has not asked the server BEFORE this line, so no sentence
      // of its exists yet. Asked of the handler, not of the `if` the toast happens to sit in.
      const handler = enclosingHandler(code, chain);
      // NOTE: unreachable on this tree and on every fixture here — every toast sits inside some
      // function — and kept anyway, deliberately: a source scanner that meets a shape it does not
      // understand must answer "I cannot tell", not throw a null dereference in the middle of the
      // suite. Mutation-surviving on purpose; the alternative is a crash instead of an abstention.
      if (!handler) continue;
      if (!talkedToTheServer(code.slice(handler.start, m.index))) continue;
    }

    out.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      shown: args.replace(/\s+/g, " ").slice(0, 70),
    });
  }
  return out;
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
    expectWaiverLedger("WAIVED", WAIVED, 6);
  });
});
