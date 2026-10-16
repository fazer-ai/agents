import { describe, expect, test } from "bun:test";
import type { ToolCatalog } from "@/client/pages/agents/types";
import { voiceToolCatalog } from "@/client/pages/agents/voiceToolCatalog";

// A voice agent's Tools tab offers what a call can run: nothing that sends a file, an image or a
// document to the contact, nothing that replies in text or closes the conversation under the call.

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("the tools a voice agent's Tools tab offers", () => {
  const catalog = {
    native: named(
      "send_image",
      "handoff_to_human",
      "resolve_conversation",
      "update_labels",
      "kanban_move_card",
    ),
    integrationInstances: [
      { id: "1", tools: named("drive_send_file", "drive_search_files") },
      {
        id: "2",
        tools: named("asaas_create_pix_charge", "asaas_get_customer"),
      },
    ],
  } as unknown as ToolCatalog;

  test("drop what sends to the contact or closes the conversation, keep the rest", () => {
    const shown = voiceToolCatalog(catalog);
    expect(shown.native.map((n) => n.name)).toEqual([
      "update_labels",
      "kanban_move_card",
    ]);
    expect(
      shown.integrationInstances.map((inst) => inst.tools.map((t) => t.name)),
    ).toEqual([["drive_search_files"], ["asaas_get_customer"]]);
  });
});
