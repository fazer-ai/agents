import type { StructuredToolInterface } from "@langchain/core/tools";
import logger from "@/api/lib/logger";
import type { PreconditionState } from "@/modules/agents/tool-preconditions";
import { DEFAULT_TIMEZONE } from "../time";
import {
  CODE_TOOL_CONTEXT_MAX_CHARS,
  CODE_TOOL_INPUT_MAX_CHARS,
  formatSandboxResult,
  runSandboxedCode,
  type SandboxOutcome,
} from "./code-sandbox";
import { markEffectFree } from "./effect-free";
import { failableTool, toolFailure } from "./failure";
import { parseToolInputSchema, sanitizeToolName } from "./http";

// Operator-authored code tools: a JavaScript body written once in the console, run in the sandbox
// (code-sandbox.ts) as `function (input, context)`. The model supplies `input` only, since a rule
// the model applies or writes per turn varies. `context` adds the two precondition attribute bags,
// read when CALLED so an earlier step's `set_custom_attribute` is seen (not one in the same batch:
// `ToolNode` runs those with `Promise.all`). A body failure or an unavailable sandbox is the
// OPERATOR's, so it is a ToolFailure (failure.ts). Design: docs/graph.md, `src/graph/tools/code.ts`.

export interface LoadedCodeToolDef {
  name: string;
  description: string;
  // The compact AI-field map an HTTP tool carries too (http.ts parseToolInputSchema).
  inputSchema: unknown;
  // The body of `function (input, context) { … }`.
  code: string;
}

export interface CodeToolDeps {
  // The agent's zone: `Date`, `TIMEZONE` and `NOW_LOCAL` inside the body follow it.
  timezone?: string;
  // The HTTP tools' context variables for this turn (prepare.ts httpToolContext plus the ids).
  context?: Record<string, string>;
  // The two attribute bags, read at call time. Absent ⇒ empty bags (the playground, a test).
  loadState?: () => Promise<PreconditionState>;
  // Injectable for tests: the sandbox itself.
  run?: typeof runSandboxedCode;
}

export interface CodeToolRun {
  outcome: SandboxOutcome | { kind: "input_too_large"; chars: number };
  // The text the model reads, for a value; the failure sentence, otherwise.
  text: string;
  failed: boolean;
}

// The sentence every failure ends with: what the model should do about a tool it cannot use. The
// verdict-shaped tools this kind is for (a CPF, a CNPJ, a date) are exactly the ones whose absence
// must not be read as "invalid".
const WITHOUT_IT =
  "Answer without this tool, and do not tell the customer their data is invalid on that basis.";

export async function runCodeToolDefinition(
  def: LoadedCodeToolDef,
  input: Record<string, unknown>,
  deps: CodeToolDeps = {},
): Promise<CodeToolRun> {
  const inputChars = JSON.stringify(input ?? {}).length;
  if (inputChars > CODE_TOOL_INPUT_MAX_CHARS) {
    // NOTE: The model's doing, not the operator's: a normal result that says what to change, the way
    // a schema refusal does.
    return {
      outcome: { kind: "input_too_large", chars: inputChars },
      text: `The arguments are too large (${inputChars} characters of JSON; the limit is ${CODE_TOOL_INPUT_MAX_CHARS}). Call again with less.`,
      failed: false,
    };
  }
  let state: PreconditionState;
  try {
    state = deps.loadState
      ? await deps.loadState()
      : { conversationAttributes: {}, contactAttributes: {} };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // The reason stays SERVER-side. Every other reason this function reports is one of ours (the
    // body's own SyntaxError, a limit, the sandbox failing to start), but this one is the database
    // driver's, and a driver message carries SQL, a host and sometimes a role — text that would
    // otherwise be posted to the model provider and kept in the flow log. The operator reads it in
    // the server log, where the rest of the driver's failures already are.
    logger.warn({ err: e, tool: def.name }, "code tool context read failed");
    return {
      outcome: { kind: "unavailable", reason },
      text: `${def.name} failed: the conversation context could not be read. ${WITHOUT_IT}`,
      failed: true,
    };
  }
  const context = {
    ...(deps.context ?? {}),
    conversationAttributes: state.conversationAttributes,
    contactAttributes: state.contactAttributes,
  };
  // Unlike the arguments above, nobody in this turn chose how big this is: the two bags are the
  // tenant's own custom attributes, and eight calls can be crossing at once. So it is bounded
  // before the thread is spawned, and it FAILS rather than being trimmed — a body that reads an
  // attribute from a silently cut bag would answer a confident verdict about data it never saw.
  const contextChars = JSON.stringify(context)?.length ?? 0;
  if (contextChars > CODE_TOOL_CONTEXT_MAX_CHARS) {
    return {
      outcome: {
        kind: "unavailable",
        reason: `context is ${contextChars} characters of JSON (limit ${CODE_TOOL_CONTEXT_MAX_CHARS})`,
      },
      text: `${def.name} failed: the conversation's attributes are too large to pass to a code tool (${contextChars} characters of JSON; the limit is ${CODE_TOOL_CONTEXT_MAX_CHARS}). ${WITHOUT_IT}`,
      failed: true,
    };
  }
  const run = deps.run ?? runSandboxedCode;
  const outcome = await run(def.code, {
    clock: { timezone: deps.timezone || DEFAULT_TIMEZONE },
    call: { input, context },
  });
  if (outcome.kind === "unavailable") {
    return {
      outcome,
      text: `${def.name} failed: the code sandbox could not start (${outcome.reason}). ${WITHOUT_IT}`,
      failed: true,
    };
  }
  if (outcome.kind === "value") {
    return { outcome, text: formatSandboxResult(outcome), failed: false };
  }
  // The reason on the first line (the flow log keeps it as the cause), the body's own console
  // output after it, for the operator reading the trace.
  const [reason, ...rest] = formatSandboxResult(outcome).split("\n");
  const tail = rest.length > 0 ? `\n${rest.join("\n")}` : "";
  return {
    outcome,
    text: `${def.name} failed: ${reason} This is the tool's own code, which its author has to fix. ${WITHOUT_IT}${tail}`,
    failed: true,
  };
}

export function buildCodeTool(
  def: LoadedCodeToolDef,
  deps: CodeToolDeps = {},
): StructuredToolInterface {
  return failableTool(
    async (input: Record<string, unknown>) => {
      const r = await runCodeToolDefinition(def, input ?? {}, deps);
      return r.failed ? toolFailure(r.text) : r.text;
    },
    {
      // `sanitizeToolName`, exactly as buildHttpTool does: the row is canonicalized on write, and
      // this keeps a row written before that (or by a path that wrote past the service) from
      // reaching the model under a name the namespace checks never saw.
      name: sanitizeToolName(def.name),
      description: def.description,
      schema: parseToolInputSchema(def.inputSchema),
    },
  );
}

export function buildCodeTools(
  defs: LoadedCodeToolDef[],
  deps: CodeToolDeps = {},
): StructuredToolInterface[] {
  // NOTE: effect-free by construction (the sandbox has no fetch, process, require, timers or thread
  // globals), so a second run duplicates nothing. Marked on the object, not by name, because an
  // operator names these tools (effect-free.ts).
  return defs.map((d) => markEffectFree(buildCodeTool(d, deps)));
}
