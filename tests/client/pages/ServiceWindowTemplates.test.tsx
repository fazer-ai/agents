/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
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
};

function stubTemplates(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.includes("service-window-templates")) {
      return new Response(JSON.stringify({ templates: [LEMBRETE] }), {
        headers: { "content-type": "application/json" },
      });
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
function Harness() {
  const [value, setValue] = useState<ServiceWindowForm>(
    structuredClone(SERVICE_WINDOW_FORM_DEFAULTS),
  );
  last = value;
  return (
    <ServiceWindowTemplates agentId="1" value={value} onChange={setValue} />
  );
}

describe("ServiceWindowTemplates", () => {
  test("a reminder's own template takes a field per placeholder and previews the filled message", async () => {
    stubTemplates();
    render(<Harness />);
    const own = await screen.findAllByText("Choose a template for this kind");
    // Kinds render in PROACTIVE_KINDS order; the reminder is the third.
    fireEvent.click(own[2] as HTMLElement);
    await waitFor(() =>
      expect(
        screen.getAllByRole("combobox", { name: "Template name (HSM)" }).length,
      ).toBe(2),
    );
    const pickers = screen.getAllByRole("combobox", {
      name: "Template name (HSM)",
    });
    fireEvent.change(pickers[1] as HTMLElement, {
      target: { value: "lembrete_agendamento\u0000pt_BR" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Body {{2}}")).not.toBeNull(),
    );
    const set = (label: string, v: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
    set("Header {{1}}", "{{dia_semana_agendamento}}");
    set("Body {{1}}", "{{primeiro_nome}}");
    set("Body {{2}}", "{{data_agendamento}}");
    set("Body {{3}}", "{{hora_agendamento}}");
    set('Button "Ver": end of the URL', "{{agenda}}");
    const preview = await screen.findByTestId("service-window-preview");
    const text = preview.textContent ?? "";
    expect(text).toContain("Olá, Maria! Dia ");
    expect(text).toContain("às 14:30.");
    expect(text).not.toContain("{{");
    // The customer sees the buttons too, so the preview shows them.
    expect(text).toContain("Ver");
    const stored = serviceWindowToStored(last);
    expect(stored.templates.appointment_reminder?.params).toEqual([
      "{{primeiro_nome}}",
      "{{data_agendamento}}",
      "{{hora_agendamento}}",
    ]);
    expect(stored.templates.appointment_reminder?.buttonParams).toEqual([
      "{{agenda}}",
    ]);
    expect(stored.templateName).toBeNull();
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
