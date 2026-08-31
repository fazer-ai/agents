import { describe, expect, test } from "bun:test";
import { buildSimulatedNativeTools } from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { applyToolMocks } from "@/modules/playground/service";

// A client whose every method throws if called — proves the simulated tools never touch Chatwoot.
const explodingClient = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error("client should not be called for a simulated tool");
      };
    },
  },
) as unknown as ChatwootClient;

describe("buildSimulatedNativeTools (P4)", () => {
  test("conversation tools are simulated (no client call); utility tools run for real", async () => {
    const tools = buildSimulatedNativeTools(
      { client: explodingClient, conversationId: 0 },
      ["handoff_to_human", "assign_label", "calculator"],
    );
    const handoff = tools.find((t) => t.name === "handoff_to_human");
    const label = tools.find((t) => t.name === "assign_label");
    const calc = tools.find((t) => t.name === "calculator");
    expect(handoff).toBeDefined();
    expect(label).toBeDefined();
    expect(calc).toBeDefined();

    // The conversation tool returns a synthetic success and never reaches the (exploding) client.
    const out = String(
      await handoff?.invoke({ reason: "preciso de um humano" }),
    );
    expect(out.toLowerCase()).toContain("simulated");

    // assign_label is conversation-scoped too → simulated (read/write labels never hit the client).
    const labelOut = String(await label?.invoke({ label: "vip" }));
    expect(labelOut.toLowerCase()).toContain("simulated");

    // The utility tool still computes for real.
    const calcOut = String(await calc?.invoke({ expression: "2 + 3" }));
    expect(calcOut).toContain("5");
  });
});

describe("applyToolMocks (P4)", () => {
  // Issue #454, review round 3. `skip_reply` is conversation-scoped by category, so it used to be
  // wrapped like the rest — and its RETURN is the whole tool: LangGraph calls the model again after
  // a tool result, and "Produce no message now" is the instruction that makes the follow-up silent.
  // Replaced by the generic `[simulated]` line, the playground writes a message production suppresses,
  // which is the simulation lying about the one decision it exists to show.
  test("skip_reply keeps its real acknowledgement instead of the simulated line", async () => {
    const tools = buildSimulatedNativeTools(
      { client: explodingClient, conversationId: 0 },
      ["skip_reply", "handoff_to_human"],
    );
    const skip = tools.find((t) => t.name === "skip_reply");
    expect(skip).toBeDefined();
    const out = String(await skip?.invoke({}));
    expect(out.toLowerCase()).not.toContain("simulated");
    expect(out).toContain("Produce no message now");
    // With a reason, the real tool echoes it — and it still never reaches the exploding client.
    const withReason = String(
      await skip?.invoke({ reason: "nothing new to say" }),
    );
    expect(withReason).toContain("nothing new to say");
    // The neighbours are untouched: this is an exemption for one tool, not the end of simulation.
    const handoff = tools.find((t) => t.name === "handoff_to_human");
    expect(
      String(await handoff?.invoke({ reason: "x" })).toLowerCase(),
    ).toContain("simulated");
  });

  test("a mock overrides the tool's result; unmatched tools are untouched", async () => {
    const base = buildSimulatedNativeTools(
      { client: explodingClient, conversationId: 0 },
      ["calculator"],
    );
    const mocked = applyToolMocks(base, { calculator: "MOCKED RESULT" });
    const calc = mocked.find((t) => t.name === "calculator");
    expect(String(await calc?.invoke({ expression: "2 + 2" }))).toBe(
      "MOCKED RESULT",
    );

    // No mocks → same tools back (real behavior preserved).
    const untouched = applyToolMocks(base, {});
    const calc2 = untouched.find((t) => t.name === "calculator");
    expect(String(await calc2?.invoke({ expression: "2 + 2" }))).toContain("4");
  });
});
