import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  CLIENT_CHANNEL_NATIVES,
  type NativeHandlers,
  unsupported,
} from "@/graph/tools/channel-natives";
import {
  buildChannelNativeTools,
  buildNativeTools,
  buildSimulatedNativeTools,
} from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";

// The lists each path offered BEFORE the natives were decided per channel, written out by hand so
// the maps cannot agree with themselves: an inbox turn gets every granted native, an observation
// every one but the three that act in front of the customer, the playground every one with the
// conversation natives simulated except `skip_reply`.
const ALL = [...NATIVE_TOOL_NAMES].sort();
const CUSTOMER_FACING = [
  "open_case_in_inbox",
  "react_to_message",
  "send_image",
];
const PLAYGROUND_REAL = ["calculator", "get_current_time", "skip_reply"];

const client = {} as ChatwootClient;
const muted = { muted: true } as unknown as ChatwootClient;
const everythingConfigured = {
  conversationId: 1,
  crossInboxCase: {
    config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 9 },
    contactId: 55,
  },
  contactFields: { context: ["name" as const], writable: ["name" as const] },
};

const names = (tools: StructuredToolInterface[]) =>
  tools.map((t) => t.name).sort();

async function simulatedNames(tools: StructuredToolInterface[]) {
  const out: string[] = [];
  for (const t of tools) {
    // Straight to the function, past the schema the stub keeps: only the stub answers this way,
    // and a real tool handed nothing errors instead.
    const func = (t as unknown as { func: (args: unknown) => Promise<unknown> })
      .func;
    const r = await Promise.resolve()
      .then(() => func({}))
      .catch(() => "");
    if (String(r).startsWith("[simulated]")) out.push(t.name);
  }
  return out.sort();
}

describe("natives per channel", () => {
  test("an inbox turn is offered every granted native, as before", () => {
    expect(
      names(buildNativeTools({ client, ...everythingConfigured })),
    ).toEqual(ALL);
    expect(
      names(buildNativeTools({ client, ...everythingConfigured }, [])),
    ).toEqual(["update_contact"]);
  });

  test("an observation is offered all but the customer-facing natives, as before", () => {
    expect(
      names(buildNativeTools({ client: muted, ...everythingConfigured })),
    ).toEqual(ALL.filter((n) => !CUSTOMER_FACING.includes(n)));
  });

  test("the playground offers every native and simulates the conversation ones, as before", async () => {
    const tools = buildSimulatedNativeTools({
      client,
      ...everythingConfigured,
    });
    expect(names(tools)).toEqual(ALL);
    expect(await simulatedNames(tools)).toEqual(
      ALL.filter((n) => !PLAYGROUND_REAL.includes(n)),
    );
  });

  test("the client channel is offered no native that acts on a conversation", () => {
    expect(
      names(
        buildChannelNativeTools(
          { client, ...everythingConfigured },
          undefined,
          CLIENT_CHANNEL_NATIVES,
        ),
      ),
    ).toEqual(["calculator", "get_current_time"]);
  });

  test("a channel that forgets a native, or names one that does not exist, does not compile", () => {
    // @ts-expect-error every native needs a decision
    const missing = { calculator: "real" } satisfies NativeHandlers;
    const extra = {
      ...CLIENT_CHANNEL_NATIVES,
      // @ts-expect-error not a native
      send_carrier_pigeon: unsupported("no"),
    } satisfies NativeHandlers;
    expect(missing).toBeDefined();
    expect(extra).toBeDefined();
  });
});
