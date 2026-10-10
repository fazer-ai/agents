import { spyOn } from "bun:test";
import { ToolFlowLogger } from "@/graph/tool-flowlog";

// How many times a tool logger was settled while `run` ran. The settle is what turns a tool that
// failed on every call into the turn's one `warn`: a logger built and never settled leaves those
// failures at `info`, out of the health block and the alerts. A rejection of `run` is swallowed, since
// the exits that end in a throw are the ones most easily left unsettled.
export async function settlesDuring(
  run: () => Promise<unknown>,
): Promise<number> {
  const settle = spyOn(ToolFlowLogger.prototype, "settle");
  try {
    await run().catch(() => {});
    return settle.mock.calls.length;
  } finally {
    settle.mockRestore();
  }
}

// A model that dies on its first call: the turn's invoke throws before any tool runs.
export const throwingModel = {
  invoke: async (): Promise<never> => {
    throw new Error("the model call failed");
  },
  bindTools() {
    return throwingModel;
  },
};
