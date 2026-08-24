/**
 * biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings below are SOURCE CODE fed to
 * the rule under test, and the template hole is the shape the rule reads.
 */
import { describe, expect, test } from "bun:test";

// THE GUARD AGAINST THE NEXT REFUSAL THAT KNOWS A FIELD AND DOES NOT SAY SO.
//
// The defect #231 fixed was never that the server did not know which value it refused: it knew, as a
// typed argument, and then spent that argument on prose. `SettingsTextTooLongError` took `(field,
// length, max)` and interpolated the field into a sentence; `bigOrThrow` wrote `${field} is
// required`. Both are the same shape, and the shape is the thing that comes back: a refusal is
// written next to the code that raises it, and the wire format is somewhere else entirely.
//
// So the rule is checked where it can fail: a refusal whose message or interpolation params mention
// a `field` in scope must also hand that field to the wire. What this catches is the sentence that
// spells out a name the body does not carry. What it CANNOT catch is a refusal that never names the
// field in either place (`updateCompanySettings` builds its prose in a helper), so the sweep is a
// floor, not a proof.

const REFUSAL_ROOT = "AppError";

// Every class that IS a refusal, resolved from the source rather than listed here: a subclass added
// tomorrow is covered on the day it is written, which is the only day this check is worth anything.
function refusalClasses(sources: Map<string, string>): Set<string> {
  const parents = new Map<string, string>();
  for (const src of sources.values()) {
    for (const m of src.matchAll(/class\s+(\w+)\s+extends\s+(\w+)/g)) {
      parents.set(m[1] as string, m[2] as string);
    }
  }
  const names = new Set<string>([REFUSAL_ROOT]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of parents) {
      if (names.has(parent) && !names.has(child)) {
        names.add(child);
        grew = true;
      }
    }
  }
  return names;
}

// The text between one call's parentheses, split at the commas that belong to IT, never the ones
// inside a nested call, an object literal or a template hole.
export function topLevelArgs(argText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i] as string;
    if (quote) {
      if (c === "\\") {
        current += c + (argText[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function callArgsAt(src: string, openParen: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i] as string;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return null;
}

// Only the CODE of an argument, never the prose: a sentence can contain the word "field" (a tool
// error says "via a fixed field") without any field being in scope, and a template hole is code
// even though it lives inside a string.
export function codeOnly(text: string): string {
  let out = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (quote === "`" && c === "$" && text[i + 1] === "{") {
        depth = 1;
        i++;
        for (let j = i + 1; j < text.length && depth > 0; j++) {
          const h = text[j] as string;
          if (h === "{") depth++;
          if (h === "}") depth--;
          if (depth > 0) out += h;
          i = j;
        }
        out += " ";
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    out += c;
  }
  return out;
}

const NAMES_A_FIELD = /(?<![.\w])field(?![\w:])/;

// A refusal that spells a field into its sentence must pass that field as the wire argument.
export function fieldOffenders(src: string, classNames: Set<string>): string[] {
  const declaresRefusal = [...classNames].some((n) =>
    new RegExp(`extends\\s+${n}\\b`).test(src),
  );
  const callHeads = [...classNames].map((n) => `new ${n}(`);
  if (declaresRefusal) callHeads.push("super(");
  const out: string[] = [];
  for (const head of callHeads) {
    let at = src.indexOf(head);
    while (at !== -1) {
      const args = callArgsAt(src, at + head.length - 1);
      at = src.indexOf(head, at + head.length);
      if (args === null) continue;
      const parts = topLevelArgs(args);
      const names =
        NAMES_A_FIELD.test(codeOnly(parts[0] ?? "")) ||
        NAMES_A_FIELD.test(codeOnly(parts[3] ?? ""));
      if (!names) continue;
      if ((parts[4] ?? "") === "") {
        out.push(`${head}…) names a field in its message but sends none`);
      }
    }
  }
  return out;
}

async function sources(): Promise<Map<string, string>> {
  const { Glob } = await import("bun");
  const files = new Map<string, string>();
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    files.set(file, await Bun.file(file).text());
  }
  return files;
}

describe("a refusal that knows a field says so on the wire", () => {
  test("no call site spends a field name on prose alone", async () => {
    const files = await sources();
    const classNames = refusalClasses(files);
    // The set resolves through the tree, not from a literal list.
    expect(classNames.has("SettingsTextTooLongError")).toBe(true);
    expect(classNames.has("NotFoundError")).toBe(true);
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const problem of fieldOffenders(src, classNames)) {
        offenders.push(`${path}: ${problem}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The predicate against a known positive and a known negative: a sweep that matches nothing
  // reports a clean tree forever.
  test("the rule recognises the shape it was written for, and leaves bystanders alone", () => {
    const names = new Set(["AppError"]);
    expect(
      fieldOffenders(
        "throw new AppError(`${field} is required`, 400, 'errors.x');",
        names,
      ),
    ).toHaveLength(1);
    expect(
      fieldOffenders(
        "throw new AppError(`${field} is required`, 400, 'errors.x', undefined, field);",
        names,
      ),
    ).toHaveLength(0);
    // Not a field name: a property read and an object KEY are both about something else.
    expect(
      fieldOffenders("throw new AppError(`${o.field} bad`, 400);", names),
    ).toHaveLength(0);
    expect(
      fieldOffenders("throw new AppError('x', 400, 'k', { field: 1 });", names),
    ).toHaveLength(0);
    // The English word, inside a sentence, with nothing in scope by that name.
    expect(
      fieldOffenders(
        "throw new AppError(`tool ${n}: needs {{secret}} (via a fixed field)`, 400);",
        names,
      ),
    ).toHaveLength(0);
  });

  test("the splitter keeps a call's own commas apart from everything nested", () => {
    expect(
      topLevelArgs('`a, b`, 400, "k", { field, len: 1, max: 2 }, field'),
    ).toEqual(["`a, b`", "400", '"k"', "{ field, len: 1, max: 2 }", "field"]);
  });
});
