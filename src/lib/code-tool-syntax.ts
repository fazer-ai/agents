// Static check of a code tool's body, shared by the console (while the operator types) and by the
// service (on save). It WARNS and never refuses: invalid code is stored as written and fails at
// call time, as the operator's failure, so a half-typed body can be saved and a warning can be
// wrong without locking anyone out. The parser is acorn, a pure-JS ECMAScript parser, because the
// console runs under a production CSP with neither 'unsafe-eval' nor 'wasm-unsafe-eval': a
// `new Function(body)` check passes every local test and throws EvalError on the first deploy, and
// the interpreter itself (QuickJS over WebAssembly) cannot load in the browser either. What the
// engine says at call time remains the truth; this is the same parse, one keystroke earlier.
//
// The body is parsed exactly as the sandbox runs it — as the body of `function (input, context)`
// — so a top-level `return` is fine and a line the parser reports is the body's own line minus the
// wrapper's one line above it (code-sandbox.worker.ts keeps the same offset for the engine's
// errors).

export type CodeSyntaxWarning =
  | { kind: "syntax"; line: number; column: number; message: string }
  // No `return` anywhere in the body itself (nested functions do not count): the tool would answer
  // `undefined` on every call, which is the mistake a first-time author makes most.
  | { kind: "noReturn" };

const WRAPPER_HEAD = "(function (input, context) {\n";
const WRAPPER_TAIL = "\n})";

// ES2023 is what QuickJS 2024-01 implements; a construct acorn accepts at a later level (decorators,
// `using`) would parse clean here and fail in the engine, which the call-time error still reports.
const ECMA_VERSION = 2023;

export async function checkCodeToolSyntax(
  code: string,
): Promise<CodeSyntaxWarning[]> {
  const { parse } = await import("acorn");
  let program: AcornNode;
  try {
    program = parse(`${WRAPPER_HEAD}${code}${WRAPPER_TAIL}`, {
      ecmaVersion: ECMA_VERSION,
      sourceType: "script",
      locations: true,
    }) as unknown as AcornNode;
  } catch (e) {
    return [syntaxWarning(e, code.split("\n"))];
  }
  return hasReturn(program) ? [] : [{ kind: "noReturn" }];
}

interface AcornNode {
  type: string;
  [key: string]: unknown;
}

function syntaxWarning(e: unknown, lines: string[]): CodeSyntaxWarning {
  const err = e as {
    message?: unknown;
    loc?: { line?: unknown; column?: unknown };
  };
  const rawLine = typeof err.loc?.line === "number" ? err.loc.line : 1;
  const rawColumn = typeof err.loc?.column === "number" ? err.loc.column : 0;
  // NOTE: One wrapper line above the body. An error at the END of the body (an unfinished
  // `input.cpf.`, an unclosed brace) is reported on the wrapper's closing line, past the body, and
  // lands at the end of the body's last line instead — the same clamp the sandbox applies to the
  // engine's line (code-sandbox.worker.ts withSourceLine).
  const past = rawLine - 1 > lines.length;
  const line = past ? lines.length : Math.max(rawLine - 1, 1);
  const column = past ? (lines[lines.length - 1]?.length ?? 0) : rawColumn;
  const message = String(err.message ?? "invalid code").replace(
    /\s*\(\d+:\d+\)$/,
    "",
  );
  return { kind: "syntax", line, column, message };
}

// The wrapper is the one function in the program; a `return` that belongs to a function nested in
// it answers that function, not the tool.
function hasReturn(program: AcornNode): boolean {
  const wrapper = firstFunction(program);
  if (!wrapper) return false;
  return containsReturn(wrapper.body as AcornNode);
}

function firstFunction(node: AcornNode): AcornNode | undefined {
  if (node.type === "FunctionExpression") return node;
  for (const child of children(node)) {
    const found = firstFunction(child);
    if (found) return found;
  }
  return undefined;
}

function containsReturn(node: AcornNode): boolean {
  if (node.type === "ReturnStatement") return true;
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return false;
  }
  return children(node).some(containsReturn);
}

function children(node: AcornNode): AcornNode[] {
  const out: AcornNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "loc" || key === "start" || key === "end")
      continue;
    if (Array.isArray(value)) {
      for (const v of value) if (isNode(v)) out.push(v);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function isNode(v: unknown): v is AcornNode {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string"
  );
}
