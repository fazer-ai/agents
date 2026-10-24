/// <reference lib="dom" />
import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import {
  type InboxOption,
  OccurrenceInboxesSection,
} from "@/client/pages/resources/OccurrenceInboxes";

// The monitor's inbox picker is the agent editor's "Other inboxes" one: chips, a searchable list, the
// inbox named as the other pickers name it, and an inbox no agent receives offered like any other,
// marked as read from Chatwoot every round.
afterEach(cleanup);

const inbox = (
  id: string,
  name: string,
  agentId: string | null,
  account?: { id: number; name: string | null },
): InboxOption => ({
  id,
  chatwootInstanceId: "1",
  chatwootInboxId: Number(id),
  name,
  channelType: "Channel::Whatsapp",
  provider: null,
  agentId,
  observerAgentIds: [],
  voiceAgentId: null,
  ...(account ? { account } : {}),
});

let saved: string[] = [];
function Harness({
  inboxes,
  initial,
}: {
  inboxes: InboxOption[];
  initial: string[];
}) {
  const [value, setValue] = useState(initial);
  saved = value;
  return (
    <OccurrenceInboxesSection
      inboxes={inboxes}
      value={value}
      onChange={setValue}
    />
  );
}

const trigger = () =>
  screen.getByRole("button", { name: "Inboxes the monitor reads" });

async function openList() {
  fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false });
  return screen.findByRole("menu");
}

const chips = () =>
  screen
    .queryAllByRole("button", { name: "Remove", hidden: true })
    .map((b) => b.parentElement?.textContent ?? "");

describe("the monitor's inbox picker", () => {
  test("chosen inboxes are chips, the list searches, and a pick adds a chip", async () => {
    render(
      <Harness
        inboxes={[
          inbox("1", "Vendas", "7"),
          inbox("2", "Suporte", "7"),
          inbox("3", "Cobrança", "7"),
        ]}
        initial={["1"]}
      />,
    );
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(chips()).toEqual(["Vendas"]);
    const menu = await openList();
    fireEvent.change(within(menu).getByRole("textbox"), {
      target: { value: "Sup" },
    });
    expect(
      within(menu).queryByRole("menuitem", { name: /Cobrança/ }),
    ).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Suporte/ }));
    await waitFor(() => expect(saved).toEqual(["1", "2"]));
    expect(chips()).toEqual(["Vendas", "Suporte"]);
  });

  test("an inbox no agent receives is offered like any other, marked as read from Chatwoot every round, with one line saying how", async () => {
    render(
      <Harness
        inboxes={[
          inbox("1", "Vendas", "7"),
          inbox("2", "Ninguém A", null),
          { ...inbox("4", "Só observada", null), observerAgentIds: ["9"] },
        ]}
        initial={[]}
      />,
    );
    const menu = await openList();
    expect(
      within(menu).getByRole("menuitem", { name: /Ninguém A/ }).textContent,
    ).toContain("read from Chatwoot every round");
    expect(
      within(menu).getByRole("menuitem", { name: /Só observada/ }).textContent,
    ).not.toContain("read from Chatwoot");
    expect(screen.queryByText(/not listed/)).toBeNull();
    expect(screen.queryByText(/read through the Chatwoot API/)).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Ninguém A/ }));
    await waitFor(() => expect(saved).toEqual(["2"]));
    expect(
      screen.getByText(
        "An inbox no agent receives is read through the Chatwoot API once per round, not as its messages arrive: each round lists its recent conversations and reads the ones whose customer wrote. Nothing is changed in Chatwoot.",
      ),
    ).toBeTruthy();
  });

  test("a repeated name carries the account, on the option and on the chip; a unique one does not", async () => {
    render(
      <Harness
        inboxes={[
          inbox("1", "SAC WhatsApp", "7", { id: 3, name: "Loja Centro" }),
          inbox("2", "SAC WhatsApp", "7", { id: 4, name: null }),
          inbox("3", "Único", "7"),
        ]}
        initial={[]}
      />,
    );
    const menu = await openList();
    for (const name of [
      "SAC WhatsApp · Loja Centro",
      "SAC WhatsApp · Account 4",
      "Único",
    ])
      fireEvent.click(within(menu).getByRole("menuitem", { name }));
    await waitFor(() =>
      expect(chips()).toEqual([
        "SAC WhatsApp · Loja Centro",
        "SAC WhatsApp · Account 4",
        "Único",
      ]),
    );
  });

  test("a chosen inbox that lost its agent stays as a chip marked as read from Chatwoot, and is removed like any other", async () => {
    render(
      <Harness
        inboxes={[inbox("1", "Vendas", "7"), inbox("2", "Suporte", null)]}
        initial={["1", "2"]}
      />,
    );
    expect(chips()).toEqual([
      "Vendas",
      "Suporteread from Chatwoot every round",
    ]);
    const remove = screen.getAllByRole("button", { name: "Remove" })[1];
    fireEvent.click(remove as HTMLElement);
    await waitFor(() => expect(saved).toEqual(["1"]));
    expect(chips()).toEqual(["Vendas"]);
  });
});
