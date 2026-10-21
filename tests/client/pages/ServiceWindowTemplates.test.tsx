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
import { RangeHolds, useRangeHeld } from "@/client/components";
import {
  SERVICE_WINDOW_FORM_DEFAULTS,
  type ServiceWindowForm,
  ServiceWindowTemplates,
  serviceWindowToForm,
  serviceWindowToStored,
} from "@/client/pages/agents/ServiceWindowTemplates";

// The 24h window's templates on the Behavior tab. A kind gets its own template from the
// inbox's synced list, one field per placeholder of each component, and a preview the send's own
// function renders. Every assertion reduces to a string or a number before expect (a failing
// expectation holding a DOM node stalls the runner on happy-dom).

const realFetch = globalThis.fetch;

const LEMBRETE = {
  name: "lembrete_agendamento",
  language: "pt_BR",
  category: "UTILITY",
  parameterFormat: "POSITIONAL",
  header: { format: "TEXT", text: "Sua visita {{1}}" },
  body: "Olá, {{1}}! Dia {{2}} às {{3}}.",
  footer: null,
  buttons: [{ type: "URL", text: "Ver", url: "https://x.test/{{1}}" }],
  examples: {
    header: ["amanhã"],
    body: ["Gabriel", "22/10", "14:30"],
    buttons: ["abc-123"],
  },
};

const CODIGO = {
  ...LEMBRETE,
  name: "codigo_verificacao",
  category: "AUTHENTICATION",
};

function stubTemplates(reminderOffsets: number[] = []): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.includes("service-window-templates")) {
      return new Response(
        JSON.stringify({ templates: [LEMBRETE, CODIGO], reminderOffsets }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

let last: ServiceWindowForm = SERVICE_WINDOW_FORM_DEFAULTS;
let held = false;
function Harness({ initial }: { initial?: Partial<ServiceWindowForm> }) {
  const [value, setValue] = useState<ServiceWindowForm>({
    ...structuredClone(SERVICE_WINDOW_FORM_DEFAULTS),
    ...initial,
  });
  last = value;
  return (
    <ServiceWindowTemplates agentId="1" value={value} onChange={setValue} />
  );
}
function HeldProbe() {
  held = useRangeHeld();
  return null;
}

// Radix opens its menus on a primary-button pointerdown, not on click.
function openMenu(el: HTMLElement): void {
  fireEvent.pointerDown(el, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

// Each blank is a chip in the message; clicking it opens what fills it.
async function fillChip(index: number, pick: string | { text: string }) {
  const chips = screen.getAllByRole("button", { name: /^\+ choose$/ });
  fireEvent.click(chips[index] as HTMLElement);
  const box = await screen.findByRole("dialog", { name: "What goes here" });
  if (typeof pick === "string") {
    fireEvent.click(within(box).getByRole("button", { name: pick }));
  } else {
    fireEvent.change(within(box).getByLabelText("Or fixed text"), {
      target: { value: pick.text },
    });
  }
  fireEvent.keyDown(box, { key: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryAllByRole("dialog", { name: "What goes here" }).length,
    ).toBe(0),
  );
}

describe("ServiceWindowTemplates", () => {
  test("a reminder offset the agent arms is offered by name, and its blanks are filled in place", async () => {
    stubTemplates([24, 1]);
    render(
      <RangeHolds>
        <Harness />
        <HeldProbe />
      </RangeHolds>,
    );
    openMenu(
      await screen.findByRole("button", {
        name: "Use another template in a situation",
      }),
    );
    const items = (await screen.findAllByRole("menuitem")).map(
      (i) => i.textContent ?? "",
    );
    expect(items.some((i) => i.startsWith("Reminder 1h before"))).toBe(true);
    expect(items.some((i) => i.startsWith("Reminder 24h before"))).toBe(true);
    fireEvent.click(
      screen
        .getAllByRole("menuitem")
        .find((i) =>
          (i.textContent ?? "").startsWith("Reminder 1h before"),
        ) as HTMLElement,
    );
    const card = await screen.findByTestId("situation-reminder:1");
    const picker = within(card).getByRole("combobox", {
      name: "Template name (HSM)",
    }) as HTMLSelectElement;
    // A one-time-code template is never offered for a proactive message.
    expect(
      [...picker.options]
        .map((o) => o.value)
        .includes("codigo_verificacao\u0000pt_BR"),
    ).toBe(false);
    fireEvent.change(picker, {
      target: { value: "lembrete_agendamento\u0000pt_BR" },
    });
    // Five blanks (header, three in the body, the button's suffix), and Save waits for all of them.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /^\+ choose$/ }).length,
      ).toBe(5),
    );
    await waitFor(() => expect(held).toBe(true));
    await fillChip(0, "Appointment weekday");
    await fillChip(0, "Contact's first name");
    await fillChip(0, "Appointment date");
    await fillChip(0, "Appointment time");
    await fillChip(0, { text: "abc" });
    await waitFor(() => expect(held).toBe(false));
    const stored = serviceWindowToStored(last);
    expect(stored.reminderTemplates["1"]?.headerParams).toEqual([
      "{{dia_semana_agendamento}}",
    ]);
    expect(stored.reminderTemplates["1"]?.params).toEqual([
      "{{primeiro_nome}}",
      "{{data_agendamento}}",
      "{{hora_agendamento}}",
    ]);
    expect(stored.reminderTemplates["1"]?.buttonParams).toEqual(["abc"]);
    fireEvent.click(
      within(card).getByRole("button", {
        name: "See it as the customer gets it",
      }),
    );
    const text =
      within(card).getByTestId("service-window-message").textContent ?? "";
    expect(text).toContain("Olá, Maria! Dia ");
    expect(text).toContain("às 14:30.");
    expect(text).not.toContain("{{");
  });

  test("a fallback is stored with its variable and only offered for a variable", async () => {
    stubTemplates();
    render(
      <Harness
        initial={{
          templates: {
            followup: {
              ...SERVICE_WINDOW_FORM_DEFAULTS.def,
              name: "lembrete_agendamento",
              params: ["{{primeiro_nome}}", "x", "y"],
              headerParams: ["z"],
              buttonParams: ["w"],
            },
          },
        }}
      />,
    );
    const chip = await screen.findByRole("button", {
      name: "Contact's first name",
    });
    fireEvent.click(chip);
    const box = await screen.findByRole("dialog", { name: "What goes here" });
    fireEvent.change(within(box).getByLabelText("If this comes empty, use"), {
      target: { value: "cliente" },
    });
    await waitFor(() =>
      expect(last.templates.followup?.params[0]).toBe(
        "{{primeiro_nome|cliente}}",
      ),
    );
    // The reminder's facts are not offered outside a reminder.
    expect(
      within(box).queryAllByRole("button", { name: "Appointment date" }).length,
    ).toBe(0);
  });

  test("a saved offset no booking tool arms anymore says so instead of vanishing", async () => {
    stubTemplates([24]);
    render(
      <Harness
        initial={{
          reminderTemplates: [
            {
              offset: "2",
              choice: {
                ...SERVICE_WINDOW_FORM_DEFAULTS.def,
                name: "lembrete_agendamento",
              },
            },
          ],
        }}
      />,
    );
    const card = await screen.findByTestId("situation-reminder:2");
    await waitFor(() =>
      expect(card.textContent ?? "").toContain(
        "No booking tool of this agent sends a reminder 2h before today",
      ),
    );
  });
});

describe("a stored template the inbox no longer has", () => {
  test("shows as its own option, and choosing the empty one clears it", async () => {
    stubTemplates();
    let latest: ServiceWindowForm = SERVICE_WINDOW_FORM_DEFAULTS;
    function Retired() {
      const [value, setValue] = useState<ServiceWindowForm>({
        ...structuredClone(SERVICE_WINDOW_FORM_DEFAULTS),
        def: {
          ...SERVICE_WINDOW_FORM_DEFAULTS.def,
          name: "retirado",
          params: ["x"],
        },
      });
      latest = value;
      return (
        <ServiceWindowTemplates agentId="1" value={value} onChange={setValue} />
      );
    }
    render(<Retired />);
    await waitFor(() =>
      expect(
        screen.queryAllByText("retirado (not found in the inbox)").length,
      ).toBe(1),
    );
    const picker = screen.getAllByRole("combobox", {
      name: "Template name (HSM)",
    })[0] as HTMLSelectElement;
    expect(picker.value).toBe("\u0000missing");
    fireEvent.change(picker, { target: { value: "" } });
    await waitFor(() => expect(latest.def.name).toBe(""));
    expect(serviceWindowToStored(latest).templateName).toBeNull();
  });
});

describe("serviceWindowToForm / serviceWindowToStored", () => {
  test("a stored block survives the round trip, kinds and offsets included", () => {
    const stored = {
      enabled: true,
      windowHours: 24,
      templateName: "reengajamento",
      templateLanguage: "pt_BR",
      templateCategory: "MARKETING",
      templateParams: ["{{primeiro_nome}}, tudo bem?"],
      templateHeaderParams: [],
      templateButtonParams: [],
      templateContent: null,
      templates: {
        followup: {
          name: "x",
          language: "pt_BR",
          category: "UTILITY",
          params: ["a"],
          headerParams: [],
          buttonParams: [],
          content: null,
        },
      },
      reminderTemplates: {
        "2": {
          name: "y",
          language: "en_US",
          category: "UTILITY",
          params: [],
          headerParams: ["h"],
          buttonParams: ["", "z"],
          content: null,
        },
      },
    };
    expect(serviceWindowToStored(serviceWindowToForm(stored))).toEqual(stored);
  });
});
