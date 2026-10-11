/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  OtherInboxesFields,
  readOtherInboxesState,
} from "@/client/pages/agents/OtherInboxesFields";
import { until } from "../../utils/poll";

// Two Chatwoot accounts can each hold an inbox with the same name, channel and number; the picker
// is the only place the operator tells them apart, so with more than one account each option names
// its account. Assertions reduce to strings before expect: a DOM node in a failing expectation
// serializes a cyclic happy-dom tree.

const realFetch = globalThis.fetch;

function stub(
  accounts: { id: string; accountId: number; accountName: string }[],
) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const body = url.pathname.endsWith("/chatwoot/deployment")
      ? { deployment: null, accounts }
      : url.pathname.endsWith("/chatwoot/inboxes")
        ? {
            inboxes: accounts.map((a) => ({
              id: `9${a.id}`,
              chatwootInstanceId: a.id,
              chatwootInboxId: 7,
              name: "Suporte",
              channelType: "Channel::Email",
              provider: null,
              agentId: null,
              observerAgentIds: [],
            })),
          }
        : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// Opens the picker and waits until its options satisfy `ready`: the listing lands asynchronously.
async function optionTexts(
  ready: (texts: string[]) => boolean,
): Promise<string[]> {
  render(
    <OtherInboxesFields
      value={{ ...readOtherInboxesState({}), enabled: true }}
      onChange={() => {}}
    />,
  );
  const trigger = await screen.findByRole("button", {
    name: /Inboxes the agent reads/,
  });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  const texts = () =>
    screen.queryAllByText(/^Suporte/).map((n) => n.textContent ?? "");
  return until("the picker's options", () => {
    const now = texts();
    return ready(now) ? now : null;
  });
}

describe("the other-inbox picker across accounts", () => {
  test("with two accounts, each same-named inbox names its account", async () => {
    stub([
      { id: "1", accountId: 1, accountName: "Loja" },
      { id: "2", accountId: 2, accountName: "Franquia" },
    ]);
    const texts = await optionTexts((t) => t.includes("Suporte · Loja"));
    expect(texts).toContain("Suporte · Loja");
    expect(texts).toContain("Suporte · Franquia");
  });

  test("with one account, the option is the inbox name alone", async () => {
    stub([{ id: "1", accountId: 1, accountName: "Loja" }]);
    const texts = await optionTexts((t) => t.length > 0);
    expect(texts).toContain("Suporte");
    expect(texts.some((t) => t.includes("Loja"))).toBe(false);
  });
});
