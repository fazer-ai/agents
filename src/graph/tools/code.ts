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
import { failableTool, toolFailure } from "./failure";
import { parseToolInputSchema } from "./http";

// Operator-authored code tools (issue #363): a JavaScript function body the operator wrote once in
// the console, with a name, a description and a typed input schema, that the agent calls with
// arguments. The body runs in the sandbox (code-sandbox.ts) as `function (input, context)` and
// answers with `return`; the model supplies `input` and nothing else. The kind exists because a
// verdict left to the model is periodically wrong even when every number it holds is right, and
// because a body the MODEL wrote per turn only moved that error into the authorship (measured on
// PR #485: 2 of 6 CPF algorithms written by gpt-4o-mini were wrong, each returning a confident
// `false`). A rule written once by the tenant is where the rule stops varying.
//
// What the body sees besides `input`: `context`, the same variables an HTTP tool's `{{context}}`
// placeholders read (conversation_id, message_id, contact_*, inbox_*, company_name, agent_name)
// plus the two attribute bags a precondition reads at call time (`conversationAttributes`,
// `contactAttributes` — modules/agents/tool-preconditions.ts is the one vocabulary for both, and
// reconciling there rather than growing a second one is what that file asks for). The bags are read
// when the tool is CALLED, not when the turn is built: the customer gives the value,
// `set_custom_attribute` writes it, and the code tool that reads it runs in the same turn.
//
// Not in the same BATCH, though, and the limit is the same one a precondition over those bags has:
// `ToolNode` runs one message's tool calls with `Promise.all`, so a `set_custom_attribute` and a
// code tool the model emitted TOGETHER race, and the read can land first. What holds is ordering
// between steps — the model reads the write's result and calls the tool in its next message.
//
// A failure of the body — it does not parse, it throws, it hits a limit — is the OPERATOR's, not
// the model's: the model cannot rewrite the body, and a rule that fails silently is the failure this
// kind exists to remove. So it is a ToolFailure (failure.ts): the model reads a short sentence and
// answers without the tool, the flow log records the call at warn with the reason as its first
// line, and the alert channels carry it to the operator. `unavailable` (the sandbox itself could
// not start) is a failure for the same reason. Only a value is a normal result.

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
      name: def.name,
      description: def.description,
      schema: parseToolInputSchema(def.inputSchema),
    },
  );
}

export function buildCodeTools(
  defs: LoadedCodeToolDef[],
  deps: CodeToolDeps = {},
): StructuredToolInterface[] {
  return defs.map((d) => buildCodeTool(d, deps));
}
