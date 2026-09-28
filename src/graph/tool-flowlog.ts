import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { SKIP_REPLY_TOOL } from "@/graph/silence";
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
      // NOTE: an unreadable schema simply contributes no names, the safe direction.
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

// How many times a tool had to ask its provider again before it answered, when its artifact says so
// (`search_knowledge`'s query embedding). Only a positive count: the key is absent on a line that
// retried nothing, so its presence is the signal.
function toolRetries(output: unknown): number | undefined {
  const artifact =
    output && typeof output === "object" && "artifact" in output
      ? (output as { artifact: unknown }).artifact
      : undefined;
  const n =
    artifact && typeof artifact === "object"
      ? (artifact as { retries?: unknown }).retries
      : undefined;
  return typeof n === "number" && n > 0 ? n : undefined;
}

// A tool run's output reaches the callback as a ToolMessage-like object; surface its `content` (the
// text the model sees) rather than the LangChain wrapper. Other shapes pass through unchanged.
function toolOutputValue(output: unknown): unknown {
  if (output && typeof output === "object" && "content" in output) {
    return (output as { content: unknown }).content;
  }
  return output;
}

// The cause line of a failure a tool RETURNED (as opposed to threw). The model needs the provider's
// body and this column is documented to carry none of it, so only the first line is kept: it is the
// part WE wrote (a `toolFailure(...)` message, `HTTP 422` from ./tools/http.ts), and everything after
// it came from the other end. `logToolValues` keeps the whole string, like the arguments and result.
function failureCause(value: unknown, logValues: boolean): string {
  // NOTE: `JSON.stringify` is TYPED as string but returns undefined for `undefined`, and this
  // callback takes `unknown` from LangChain, so the coalesce is a runtime guard the type does not
  // give us.
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  if (logValues) return text;
  return text.split("\n", 1)[0] ?? "";
}

// A ToolMessage with status "error" is a tool-marked integration failure (failableTool/toolFailure),
// logged as a failure although the model got a friendly string. Thrown errors take handleToolError.
function isErrorToolOutput(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    "status" in output &&
    (output as { status?: unknown }).status === "error"
  );
}

// Logs each tool call of a turn as a `tool` execution-flow line (name, status, duration, redacted
// args/result), grouped under the turn's FlowContext. LangChain sets `runName` to the tool's
// registered name (the serialized `tool` is a stub), with a generic label as fallback. `detail` goes
// through redactSecretsDeep inside emitFlowEvent, and emits are fire-and-forget.
export class ToolFlowLogger extends BaseCallbackHandler {
  name = "fazerai-tool-flowlog";
  // INLINE, not on LangChain's background queue: by default a handler runs on one process-wide queue
  // (concurrency 1) behind every other backgrounded callback, so under load `handleToolEnd` would run
  // after the turn returned and `turnDelivered` would answer for the wrong moment. Awaiting costs
  // nothing: every handler here is synchronous and the write stays fire-and-forget.
  override awaitHandlers = true;

  private readonly flow: FlowContext;
  // What a tool call leaves in `detail`: the shape of each value by default, which is what keeps the
  // column's documented promise, or the value as sent when the agent has `observability.logToolValues`
  // on. Resolved ONCE per logger, so a turn cannot log both ways.
  private readonly describe: (
    value: unknown,
    declared: DeclaredKeys,
  ) => unknown;
  // Same switch, read on the failure path: `describe` alone cannot carry it, because a failure's
  // cause is a string the operator has to be able to read, not a shape.
  private readonly logValues: boolean;
  private readonly declaredKeys: Map<string, ReadonlySet<string>>;
  // Whether the TURN has put something in front of the customer, asked when a line is written. Only
  // `skip_reply` carries it: its marker asserts a silence, and no tool name or argument tells a
  // transfer WITH a closing line from one with nothing to say. Absent where there is no turn to ask
  // (playground, observe runner), and absent is not `false`: the reader treats it as unknown.
  private readonly turnDelivered?: () => boolean;
  private readonly starts = new Map<
    string,
    { tool: string; at: number; args: unknown }
  >();

  constructor(
    flow: FlowContext,
    opts: {
      logValues?: boolean;
      tools?: readonly StructuredToolInterface[];
      turnDelivered?: () => boolean;
    } = {},
  ) {
    super();
    this.flow = flow;
    this.turnDelivered = opts.turnDelivered;
    this.logValues = opts.logValues === true;
    this.describe = this.logValues ? (value) => value : describeShape;
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
    const retries = toolRetries(output);
    // NOTE: an integration failure returned as a friendly string (failableTool) is ONE line at level
    // warn, like handleToolError, so alert channels (minLevel warn) can subscribe.
    emitFlowEvent(this.flow, {
      stage: "tool",
      level: failed ? "warn" : "info",
      status: failed ? "error" : "ok",
      durationMs: Date.now() - s.at,
      detail: {
        tool: s.tool,
        args: s.args,
        output: this.describe(value, null),
        ...(retries !== undefined ? { retries } : {}),
        // NOTE: Asked HERE and not at handleToolStart, because a model may emit `skip_reply`
        // alongside the tool that speaks (the documented parallel batch), and ToolNode runs a batch
        // concurrently: at the start of a 0ms decision the companion has not recorded anything yet.
        ...this.deliveryStamp(s.tool),
      },
      ...(failed
        ? {
            errorMessage: sanitizeErrorMessage(
              failureCause(value, this.logValues),
            ),
          }
        : {}),
    });
  }

  // The stamp, as a fragment so the key is ABSENT rather than null on every other line: a reader
  // that sees the key at all reads it as an answer, and `false` on a line nobody asked about would
  // claim the turn stayed silent.
  private deliveryStamp(tool: string): { turnDelivered?: boolean } {
    if (tool !== SKIP_REPLY_TOOL || !this.turnDelivered) return {};
    return { turnDelivered: this.turnDelivered() };
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
