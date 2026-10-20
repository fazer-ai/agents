// What a client turn tells its caller while it runs: which server-side tool started and how it
// ended. Only the tool's name and whether it succeeded, never its arguments or result: the events
// travel to the host's browser, and what a tool read or wrote is the trail's business, not the page's.
// Client tools are left out, because the host learns of those as the `pending` calls it runs itself.

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import { SKIP_REPLY_TOOL } from "@/graph/silence";
import { isErrorToolOutput } from "@/graph/tool-flowlog";

export type ClientTurnEvent =
  | { type: "tool"; phase: "start"; name: string }
  | { type: "tool"; phase: "end"; name: string; ok: boolean };

export class ClientTurnProgress extends BaseCallbackHandler {
  name = "fazerai-client-turn-progress";
  // INLINE, like ToolFlowLogger: on LangChain's background queue an `end` could reach the caller
  // after the turn's final event.
  override awaitHandlers = true;

  private readonly runs = new Map<string, string>();

  constructor(
    private readonly emit: (event: ClientTurnEvent) => void,
    // The tools the host declared, and the silence marker, which is not work the user waits on.
    private readonly hidden: ReadonlySet<string>,
  ) {
    super();
  }

  override handleToolStart(
    _tool: Serialized,
    _input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    if (!runName || this.hidden.has(runName) || runName === SKIP_REPLY_TOOL)
      return;
    this.runs.set(runId, runName);
    this.send({ type: "tool", phase: "start", name: runName });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    this.finish(runId, !isErrorToolOutput(output));
  }

  override handleToolError(_err: unknown, runId: string): void {
    this.finish(runId, false);
  }

  private finish(runId: string, ok: boolean): void {
    const name = this.runs.get(runId);
    if (!name) return;
    this.runs.delete(runId);
    this.send({ type: "tool", phase: "end", name, ok });
  }

  // A caller that stopped listening must not fail the turn it asked for.
  private send(event: ClientTurnEvent): void {
    try {
      this.emit(event);
    } catch {
      // NOTE: the turn goes on and its result still lands in the thread.
    }
  }
}
