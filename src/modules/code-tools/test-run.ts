// Run a code tool's body ONCE, from the editor, unsaved, with arguments the operator typed (the
// `POST /v1/code-tools/test` behind the "Test" button). The loop it closes is the one n8n's "test
// step" closes: the operator sees the value, the console output or the failure before granting
// the tool to an agent, instead of coaxing the agent into calling it and reading the trace.
//
// It adds no capability — whoever reaches it can save the body and call it from the playground —
// and it runs the body through the same `runCodeToolDefinition` a turn uses, so the sandbox, the
// limits, the clock, the context shape and the failure sentence are one code path. The arguments
// are validated by the same zod schema the model's would be, so a value the schema refuses is
// reported here the way the model would see it refused.

import { ToolInputParsingException } from "@langchain/core/tools";
import { z } from "zod";
import type { CodeToolRun } from "@/graph/tools/code";
import { runCodeToolDefinition } from "@/graph/tools/code";
import { SANDBOX_CODE_MAX_CHARS } from "@/graph/tools/code-sandbox-limits";
import { parseToolInputSchema } from "@/graph/tools/http";
import { resolveTimezone } from "@/graph/tools/zone-offset";
import {
  type CodeSyntaxWarning,
  checkCodeToolSyntax,
} from "@/lib/code-tool-syntax";
import { AppError } from "@/lib/errors";
import {
  CONTEXT_VAR_NAMES,
  hasReservedFieldName,
} from "@/modules/tool-definitions/normalize";

export interface CodeToolTestInput {
  definition: {
    name?: string;
    inputSchema?: Record<string, unknown>;
    code: string;
  };
  // Values for the fields, as the model would have supplied them.
  args?: Record<string, unknown>;
  // Values for the conversation/contact variables, which no model supplies and no test has.
  // Filtered to the names the runtime actually exposes.
  context?: Record<string, string>;
  // The zone `Date` runs in; an unknown one falls back to UTC, as at run time.
  timezone?: string;
}

export interface CodeToolTestResult extends CodeToolRun {
  warnings: CodeSyntaxWarning[];
}

export async function runCodeToolTest(
  input: CodeToolTestInput,
): Promise<CodeToolTestResult> {
  const def = input.definition;
  if (typeof def?.code !== "string" || def.code.length === 0) {
    throw new AppError("code is required", 400);
  }
  // The same ceiling the row has (codeToolCreateSchema). This endpoint runs an UNSAVED body, so
  // nothing else had asked the question yet, and a body past the limit would be copied into a
  // worker and evaluated — host memory the sandbox's own 32 MB heap cap does not govern.
  if (def.code.length > SANDBOX_CODE_MAX_CHARS) {
    throw new AppError(
      `code is longer than ${SANDBOX_CODE_MAX_CHARS} characters`,
      422,
      "errors.invalidRequestValue",
      { field: "code" },
      "code",
    );
  }
  // Refused BEFORE the schema is parsed, exactly as a save is: `parseToolInputSchema` normalizes
  // and drops a `__proto__` field, so testing a definition create/update would refuse would answer
  // "fine" about a tool whose declared argument the model can never send.
  if (hasReservedFieldName(def.inputSchema)) {
    throw new AppError(
      "input schema field `__proto__` is reserved by JavaScript and cannot be a parameter name",
      422,
      "errors.invalidRequestValue",
      { field: "inputSchema" },
      "inputSchema",
    );
  }
  // The SHAPE, before the tolerant parser sees it. `parseToolInputSchema` is fed stored rows and is
  // deliberately forgiving, so a non-record value arrives as an EMPTY schema and the declared
  // arguments vanish: the body runs with `input` empty and the operator reads a green result for a
  // call that never carried their argument, then meets the service's `z.record` on save. The
  // endpoint adds no capability over a save, so it owes the same refusals (round 17, round 24).
  // `null` is refused with the rest: the service's `.optional()` accepts an ABSENT schema, not a
  // null one, and reading null as "no arguments" here would be the endpoint being kinder than the
  // save again.
  if (
    def.inputSchema !== undefined &&
    !z.record(z.string(), z.unknown()).safeParse(def.inputSchema).success
  ) {
    throw new AppError(
      "input schema must be an object mapping each argument name to its declaration",
      422,
      "errors.invalidRequestValue",
      { field: "inputSchema" },
      "inputSchema",
    );
  }
  const schema = parseToolInputSchema(def.inputSchema ?? {});
  const parsed = schema.safeParse(input.args ?? {});
  if (!parsed.success) {
    // The same refusal the model gets, in the same words, so the operator's test reads like the
    // agent's call would.
    const e = new ToolInputParsingException(parsed.error.message);
    throw new AppError(
      e.message,
      422,
      "errors.invalidRequestValue",
      { field: "args" },
      "args",
    );
  }
  const context: Record<string, string> = {};
  for (const name of CONTEXT_VAR_NAMES) {
    const v = input.context?.[name];
    if (typeof v === "string") context[name] = v;
  }
  const [warnings, run] = await Promise.all([
    checkCodeToolSyntax(def.code),
    runCodeToolDefinition(
      {
        name: def.name || "code_tool",
        description: "",
        inputSchema: def.inputSchema ?? {},
        code: def.code,
      },
      parsed.data,
      {
        timezone: resolveTimezone(input.timezone ?? "UTC"),
        context,
      },
    ),
  ]);
  return { ...run, warnings };
}
