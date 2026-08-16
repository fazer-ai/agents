import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { sanitizeErrorMessage } from "@/lib/redact";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { type DeclaredKeys, describeShape } from "@/modules/flowlog/shape";

// The parameter names each tool DECLARED, by tool name. `describeShape` names a top-level argument
// only when it appears here, so a key the model or a provider invented is counted instead of logged.
// Derived from the same schemas the model is given; a tool whose schema is not an object contributes
// nothing, which means none of its keys are ever named.
function declaredKeysByTool(
  tools: readonly StructuredToolInterface[],
): Map<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const t of tools) {
    try {
      const schema = toJsonSchema(t.schema) as {
        properties?: Record<string, unknown>;
      };
      const props = schema?.properties;
      if (props && typeof props === "object") {
        map.set(t.name, new Set(Object.keys(props)));
      }
    } catch {
      // NOTE: an unreadable schema simply contributes no names — the safe direction.
    }
  }
  return map;
}

// LangChain passes the tool input as a string on the callback. Parse it back to the structured args
// when possible, so each declared argument can be described by name; an input that is not JSON is
// described as the string it is. Empty → null.
function parseToolInput(
  input: string,
  describe: (value: unknown, declared: DeclaredKeys) => unknown,
  declared: DeclaredKeys,
): unknown {
  const s = (input ?? "").trim();
  if (!s) return null;
  try {
    return describe(JSON.parse(s), declared);
  } catch {
    return describe(s, declared);
  }
}

// A tool run's output reaches the callback as a ToolMessage-like object; surface its `content` (the
// text the model sees) rather than the LangChain wrapper. Other shapes pass through unchanged.
function toolOutputValue(output: unknown): unknown {
  if (output && typeof output === "object" && "content" in output) {
    return (output as { content: unknown }).content;
  }
  return output;
}

// NOTE: A ToolMessage with status "error" is a tool-marked integration failure (failableTool/toolFailure —
// the friendly string went to the model, but the call must be logged as a failure). Thrown errors
// take the handleToolError path instead; this only classifies returned outputs.
function isErrorToolOutput(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    "status" in output &&
    (output as { status?: unknown }).status === "error"
  );
}

// Logs each tool call the agent makes during a turn as a `tool` execution-flow line (name + status +
// duration + the redacted args/result), so the operator can SEE which tools ran AND expand the marker
// to inspect what was passed and returned (parity with the playground trace). Bound to the running
// turn's FlowContext (shares its turnId, so the tool lines group under the same turn). Like
// AgentStatusReporter, LangChain sets `runName` to the tool's registered name for tool runs (the
// serialized `tool` is a not-implemented stub); fall back to a generic label when absent. The
// args/result ride in `detail`, which emitFlowEvent passes through redactSecretsDeep (credential-named
// keys dropped, secret-shaped strings scrubbed, everything truncated) before the write. Emits are
// fire-and-forget (emitFlowEvent never throws into the turn).
export class ToolFlowLogger extends BaseCallbackHandler {
  name = "fazerai-tool-flowlog";

  private readonly flow: FlowContext;
  // What a tool call leaves in `detail`: the shape of each value by default, which is what keeps the
  // column's documented promise, or the value as sent when the agent has `observability.logToolValues`
  // on. Resolved ONCE per logger, so a turn cannot log both ways.
  private readonly describe: (
    value: unknown,
    declared: DeclaredKeys,
  ) => unknown;
  private readonly declaredKeys: Map<string, ReadonlySet<string>>;
  private readonly starts = new Map<
    string,
    { tool: string; at: number; args: unknown }
  >();

  constructor(
    flow: FlowContext,
    opts: {
      logValues?: boolean;
      tools?: readonly StructuredToolInterface[];
    } = {},
  ) {
    super();
    this.flow = flow;
    this.describe = opts.logValues === true ? (value) => value : describeShape;
    this.declaredKeys = declaredKeysByTool(opts.tools ?? []);
  }

  override handleToolStart(
    _tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const tool = runName && runName.length > 0 ? runName : "tool";
    this.starts.set(runId, {
      tool,
      at: Date.now(),
      args: parseToolInput(
        input,
        this.describe,
        this.declaredKeys.get(tool) ?? null,
      ),
    });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    const s = this.starts.get(runId);
    if (!s) return;
    this.starts.delete(runId);
    const failed = isErrorToolOutput(output);
    const value = toolOutputValue(output);
    // NOTE: Integration failure returned as a friendly string (failableTool): ONE line, level warn —
    // same level as handleToolError, so alert channels (minLevel warn) can subscribe (issue #40).
    emitFlowEvent(this.flow, {
      stage: "tool",
      level: failed ? "warn" : "info",
      status: failed ? "error" : "ok",
      durationMs: Date.now() - s.at,
      detail: {
        tool: s.tool,
        args: s.args,
        output: this.describe(value, null),
      },
      ...(failed
        ? {
            errorMessage: sanitizeErrorMessage(
              typeof value === "string" ? value : JSON.stringify(value),
            ),
          }
        : {}),
    });
  }

  override handleToolError(err: unknown, runId: string): void {
    const s = this.starts.get(runId);
    if (!s) return;
    this.starts.delete(runId);
    emitFlowEvent(this.flow, {
      stage: "tool",
      level: "warn",
      status: "error",
      durationMs: Date.now() - s.at,
      detail: { tool: s.tool, args: s.args },
      errorMessage: sanitizeErrorMessage(err),
    });
  }
}
