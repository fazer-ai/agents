import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { SKIP_REPLY_TOOL, skipReplyReasonOf } from "@/graph/silence";
import { HANDOFF_TOOL_NAME } from "@/graph/tools/catalog";
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
  // `JSON.stringify` is TYPED as string but returns undefined for `undefined`, and this
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
  private readonly handedOff?: () => boolean;
  private readonly onToolStart?: () => void;
  private readonly starts = new Map<
    string,
    { tool: string; at: number; args: unknown }
  >();
  // What each tool did across the turn, for the one line `settle` writes: a failed call is `info` when
  // it happens, because the model may call the tool again and succeed, and only a tool that failed on
  // every call it made is the turn's degraded outcome.
  private readonly outcomes = new Map<
    string,
    { failed: number; succeeded: number; cause: string; warned: boolean }
  >();
  // Set by the first `settle`. A call still running when the turn ended (a deadline rejects before
  // LangChain delivers the tool's own end or error) reports after it, and is judged when it lands.
  private settled = false;

  constructor(
    flow: FlowContext,
    opts: {
      logValues?: boolean;
      tools?: readonly StructuredToolInterface[];
      turnDelivered?: () => boolean;
      // Whether this turn's transfer to a person actually happened (`handoffState.completed`).
      handedOff?: () => boolean;
      // Told as each tool call starts, before it can act.
      onToolStart?: () => void;
    } = {},
  ) {
    super();
    this.flow = flow;
    this.turnDelivered = opts.turnDelivered;
    this.handedOff = opts.handedOff;
    this.onToolStart = opts.onToolStart;
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
    this.onToolStart?.();
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
    const cause = failed
      ? sanitizeErrorMessage(failureCause(value, this.logValues))
      : "";
    this.tally(s.tool, failed ? cause : null);
    // NOTE: an integration failure returned as a friendly string (failableTool) is `status: error`
    // and `info`: whether it degraded the turn is known at `settle`, once every call has ended.
    emitFlowEvent(this.flow, {
      stage: "tool",
      level: "info",
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
        ...skipReasonStamp(s.tool, output),
        ...this.handoffStamp(s.tool),
      },
      ...(failed ? { errorMessage: cause } : {}),
    });
  }

  private tally(tool: string, failure: string | null): void {
    const o = this.outcomes.get(tool) ?? {
      failed: 0,
      succeeded: 0,
      cause: "",
      warned: false,
    };
    if (failure === null) o.succeeded += 1;
    else {
      o.failed += 1;
      o.cause = failure;
    }
    this.outcomes.set(tool, o);
    if (this.settled) this.settleTool(tool, o);
  }

  // The turn's outcome per tool, called once the model is done calling them: one `warn` for each tool
  // that failed on every call it made, naming the tool, how many calls failed and the last cause. A
  // tool that failed and then succeeded leaves its `info` lines and nothing else. Idempotent.
  settle(): void {
    this.settled = true;
    for (const [tool, o] of this.outcomes) this.settleTool(tool, o);
  }

  private settleTool(
    tool: string,
    o: { failed: number; succeeded: number; cause: string; warned: boolean },
  ): void {
    if (o.warned || o.failed === 0 || o.succeeded > 0) return;
    // A call of this tool still running may yet succeed; its own end judges the tool when it lands.
    for (const s of this.starts.values()) if (s.tool === tool) return;
    o.warned = true;
    emitFlowEvent(this.flow, {
      stage: "tool",
      level: "warn",
      status: "error",
      detail: { tool, failedCalls: o.failed },
      errorMessage: sanitizeErrorMessage(
        `${tool} failed on every call this turn (${o.failed}): ${o.cause}`,
      ),
    });
  }

  // The stamp, as a fragment so the key is ABSENT rather than null on every other line: a reader
  // that sees the key at all reads it as an answer, and `false` on a line nobody asked about would
  // claim the turn stayed silent.
  private deliveryStamp(tool: string): { turnDelivered?: boolean } {
    if (tool !== SKIP_REPLY_TOOL || !this.turnDelivered) return {};
    return { turnDelivered: this.turnDelivered() };
  }

  // `handoff_to_human` returns normally when it declines (the run was called off while its note was
  // in flight), so a clean return is not a transfer. The turn's own mark is: the dashboard counts the
  // agent's handoffs by it. Absent where nobody can answer, as the delivery stamp is.
  private handoffStamp(tool: string): { handedOff?: boolean } {
    if (tool !== HANDOFF_TOOL_NAME || !this.handedOff) return {};
    return { handedOff: this.handedOff() };
  }

  override handleToolError(err: unknown, runId: string): void {
    const s = this.starts.get(runId);
    if (!s) return;
    this.starts.delete(runId);
    const cause = sanitizeErrorMessage(err);
    this.tally(s.tool, cause);
    emitFlowEvent(this.flow, {
      stage: "tool",
      level: "info",
      status: "error",
      durationMs: Date.now() - s.at,
      detail: { tool: s.tool, args: s.args },
      errorMessage: cause,
    });
  }
}

// `skip_reply`'s reason, recorded as its value: a closed vocabulary (acknowledged, not_for_us,
// needs_human) the model picks, not text it writes, so it says nothing about the customer and the
// shape rule for tool arguments (docs/logs.md) does not need to hide it. The dashboard counts the
// silences by it. Absent on every other tool's line, and on a skip whose result carried no mark.
function skipReasonStamp(
  tool: string,
  output: unknown,
): { skipReason?: string } {
  if (tool !== SKIP_REPLY_TOOL) return {};
  const reason = skipReplyReasonOf(output);
  return reason ? { skipReason: reason } : {};
}
