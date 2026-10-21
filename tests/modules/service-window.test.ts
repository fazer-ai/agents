import { describe, expect, test } from "bun:test";
import {
  appointmentVars,
  buildTemplatePayload,
  isWithinServiceWindow,
  misplacedAppointmentVar,
  parseTemplateDefinition,
  proactiveSendMode,
  readServiceWindowConfig,
  resolveTemplateChoice,
  SERVICE_WINDOW_DEFAULTS,
  type TemplateChoice,
  type TemplateDefinition,
  templateChoiceProblem,
} from "@/modules/service-window/service";

const NOW = new Date("2026-06-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("readServiceWindowConfig", () => {
  test("defaults: enabled, 24h, no template", () => {
    expect(readServiceWindowConfig(undefined)).toEqual(SERVICE_WINDOW_DEFAULTS);
    expect(readServiceWindowConfig({ serviceWindow: {} }).windowHours).toBe(24);
  });
  test("clamps windowHours and reads template fields", () => {
    const c = readServiceWindowConfig({
      serviceWindow: {
        windowHours: 9999,
        templateName: "reengajamento",
        templateParams: ["{primeiro_nome}", 5, "fixo"],
      },
    });
    expect(c.windowHours).toBe(168);
    expect(c.templateName).toBe("reengajamento");
    expect(c.templateParams).toEqual(["{primeiro_nome}", "fixo"]);
  });
});

describe("isWithinServiceWindow", () => {
  test("null inbound → outside (business-initiated)", () => {
    expect(isWithinServiceWindow(null, NOW, 24)).toBe(false);
  });
  test("recent inbound → inside; old → outside", () => {
    expect(isWithinServiceWindow(hoursAgo(2), NOW, 24)).toBe(true);
    expect(isWithinServiceWindow(hoursAgo(25), NOW, 24)).toBe(false);
  });
});

describe("proactiveSendMode", () => {
  const base = { ...SERVICE_WINDOW_DEFAULTS };
  // Official WhatsApp providers (have a 24h window): Cloud API + 360dialog (provider "default").
  const cloud = {
    channelType: "Channel::Whatsapp",
    provider: "whatsapp_cloud",
  };
  const dialog360 = { channelType: "Channel::Whatsapp", provider: "default" };
  test("gate disabled → freeform regardless", () => {
    expect(
      proactiveSendMode({ ...base, enabled: false }, hoursAgo(100), NOW, cloud),
    ).toBe("freeform");
  });
  test("inside window → freeform", () => {
    expect(proactiveSendMode(base, hoursAgo(2), NOW, cloud)).toBe("freeform");
  });
  test("outside window + template → template (Cloud + 360dialog)", () => {
    const withTpl = { ...base, templateName: "reengajamento" };
    expect(proactiveSendMode(withTpl, hoursAgo(48), NOW, cloud)).toBe(
      "template",
    );
    expect(proactiveSendMode(withTpl, hoursAgo(48), NOW, dialog360)).toBe(
      "template",
    );
  });
  test("outside window + no template → note", () => {
    expect(proactiveSendMode(base, hoursAgo(48), NOW, cloud)).toBe("note");
  });
  test("unofficial WhatsApp providers (baileys/zapi) → freeform even outside the window", () => {
    // baileys/zapi arrive as Channel::Whatsapp too, but with no 24h window — channel_type alone would
    // wrongly gate them; the provider is what excludes them. A template never overrides this.
    const withTpl = { ...base, templateName: "reengajamento" };
    for (const provider of ["baileys", "zapi"]) {
      const ch = { channelType: "Channel::Whatsapp", provider };
      expect(proactiveSendMode(base, hoursAgo(100), NOW, ch)).toBe("freeform");
      expect(proactiveSendMode(withTpl, hoursAgo(100), NOW, ch)).toBe(
        "freeform",
      );
    }
  });
  test("unknown/null provider or non-WhatsApp channel → freeform (no window)", () => {
    expect(
      proactiveSendMode(base, hoursAgo(100), NOW, {
        channelType: "Channel::Whatsapp",
        provider: null,
      }),
    ).toBe("freeform");
    expect(
      proactiveSendMode(base, hoursAgo(100), NOW, {
        channelType: "Channel::Api",
        provider: null,
      }),
    ).toBe("freeform");
  });
});

describe("buildTemplatePayload", () => {
  test("interpolates the contact name and builds positional body params", () => {
    const cfg = {
      ...SERVICE_WINDOW_DEFAULTS,
      templateName: "reengajamento",
      templateLanguage: "pt_BR",
      templateParams: ["{{primeiro_nome}}", "promo"],
    };
    const payload = buildTemplatePayload(cfg, "Maria Silva");
    expect(payload).not.toBeNull();
    expect(payload?.name).toBe("reengajamento");
    expect(payload?.language).toBe("pt_BR");
    expect(payload?.processedParams).toEqual({
      body: { "1": "Maria", "2": "promo" },
    });
  });
  test("returns null when no template is configured", () => {
    expect(buildTemplatePayload(SERVICE_WINDOW_DEFAULTS, "Maria")).toBeNull();
  });
});

// A template per proactive kind, the appointment's placeholders on reminders, header and URL
// button params, and the synced definition the save judges a choice against.
const LEMBRETE_DEF = parseTemplateDefinition({
  name: "lembrete_agendamento",
  language: "pt_BR",
  category: "UTILITY",
  components: [
    { type: "HEADER", format: "TEXT", text: "Lembrete: sua visita {{1}}" },
    {
      type: "BODY",
      text: "Olá, {{1}}! Sua visita é em {{2}}, às {{3}}.",
    },
    { type: "FOOTER", text: "fazer.ai" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Confirmo" },
        { type: "URL", text: "Ver", url: "https://x.test/{{1}}" },
      ],
    },
  ],
});
const REENGAJAMENTO_DEF = parseTemplateDefinition({
  name: "reengajamento",
  language: "pt_BR",
  category: "MARKETING",
  components: [{ type: "BODY", text: "Oi {{1}}, ainda tem interesse?" }],
});
const DEFS = [LEMBRETE_DEF, REENGAJAMENTO_DEF].filter(
  (d): d is TemplateDefinition => d !== null,
);

const lembrete = {
  name: "lembrete_agendamento",
  params: ["{{primeiro_nome}}", "{{data_agendamento}}", "{{hora_agendamento}}"],
  headerParams: ["{{dia_semana_agendamento}}"],
  buttonParams: ["", "agenda/{{agenda}}"],
};

describe("template per proactive kind", () => {
  const cfg = readServiceWindowConfig({
    serviceWindow: {
      templateName: "reengajamento",
      templateParams: ["{{primeiro_nome}}"],
      templates: {
        appointment_reminder: lembrete,
        inbound_event: null,
        bogus: { name: "x" },
      },
      reminderTemplates: {
        "2": { ...lembrete, name: "lembrete_2h" },
        "-1": { name: "never" },
      },
    },
  });

  test("the reader keeps the kinds it knows and drops null, unknown and invalid entries", () => {
    expect(Object.keys(cfg.templates)).toEqual(["appointment_reminder"]);
    expect(cfg.templates.appointment_reminder?.language).toBe("pt_BR");
    expect(Object.keys(cfg.reminderTemplates)).toEqual(["2"]);
  });

  test("a reminder's offset wins over its kind, its kind over the default", () => {
    expect(
      resolveTemplateChoice(cfg, {
        kind: "appointment_reminder",
        offsetHours: 2,
      })?.name,
    ).toBe("lembrete_2h");
    expect(
      resolveTemplateChoice(cfg, {
        kind: "appointment_reminder",
        offsetHours: 24,
      })?.name,
    ).toBe("lembrete_agendamento");
    expect(resolveTemplateChoice(cfg, { kind: "followup" })?.name).toBe(
      "reengajamento",
    );
    expect(resolveTemplateChoice(cfg)?.name).toBe("reengajamento");
  });

  test("a kind with its own template sends it even when the agent has no default; the others become notes", () => {
    const onlyReminder = readServiceWindowConfig({
      serviceWindow: { templates: { appointment_reminder: lembrete } },
    });
    const cloud = {
      channelType: "Channel::Whatsapp",
      provider: "whatsapp_cloud",
    };
    expect(
      proactiveSendMode(onlyReminder, hoursAgo(48), NOW, cloud, {
        kind: "appointment_reminder",
      }),
    ).toBe("template");
    expect(
      proactiveSendMode(onlyReminder, hoursAgo(48), NOW, cloud, {
        kind: "followup",
      }),
    ).toBe("note");
  });
});

describe("appointment placeholders", () => {
  const facts = (startISO: string) => ({
    startISO,
    calendarLabel: "Clínica Centro",
    fallbackTimezone: "America/Sao_Paulo",
  });

  test("a start with a stated offset is read in that wall clock, never converted", () => {
    const v = appointmentVars(facts("2026-10-22T14:30:00-03:00"), "pt_BR");
    expect(v.data_agendamento).toBe("22/10/2026");
    expect(v.hora_agendamento).toBe("14:30");
    expect(v.dia_semana_agendamento).toBe("quinta-feira");
    expect(v.agenda).toBe("Clínica Centro");
    expect(v.appointment_date).toBe(v.data_agendamento);
  });

  test("a calendar in another zone than the agent's keeps its own wall clock", () => {
    const v = appointmentVars(facts("2026-10-22T14:30:00+01:00"), "pt_BR");
    expect(v.hora_agendamento).toBe("14:30");
    expect(v.data_agendamento).toBe("22/10/2026");
  });

  test("a start in UTC is read in the agent's zone, which can be the previous day", () => {
    const v = appointmentVars(facts("2026-10-23T01:30:00Z"), "pt_BR");
    expect(v.data_agendamento).toBe("22/10/2026");
    expect(v.hora_agendamento).toBe("22:30");
    expect(v.dia_semana_agendamento).toBe("quinta-feira");
  });

  test("an all-day appointment has a date and a weekday but no time", () => {
    const v = appointmentVars(facts("2026-10-22"), "pt_BR");
    expect(v.data_agendamento).toBe("22/10/2026");
    expect(v.hora_agendamento).toBe("");
  });

  test("the template's language words the weekday", () => {
    const v = appointmentVars(facts("2026-10-22T14:30:00-03:00"), "en_US");
    expect(v.appointment_weekday).toBe("Thursday");
  });
});

describe("buildTemplatePayload with header and buttons", () => {
  const cfg = readServiceWindowConfig({
    serviceWindow: { templates: { appointment_reminder: lembrete } },
  });
  const occasion = {
    kind: "appointment_reminder" as const,
    appointment: {
      startISO: "2026-10-22T14:30:00-03:00",
      calendarLabel: "centro",
      fallbackTimezone: "America/Sao_Paulo",
    },
  };

  test("fills body, header and the dynamic button, keeping the static button's slot", () => {
    const p = buildTemplatePayload(cfg, "Maria Silva", occasion);
    expect(p?.processedParams).toEqual({
      body: { "1": "Maria", "2": "22/10/2026", "3": "14:30" },
      header: { "1": "quinta-feira" },
      buttons: [{}, { type: "url", parameter: "agenda/centro" }],
    });
  });

  test("with the synced definition, content is the text the customer reads", () => {
    const p = buildTemplatePayload(cfg, "Maria Silva", occasion, DEFS);
    expect(p?.content).toBe(
      "*Lembrete: sua visita quinta-feira*\n\nOlá, Maria! Sua visita é em 22/10/2026, às 14:30.\n\nfazer.ai",
    );
  });

  test("a NAMED template is keyed by its placeholder names", () => {
    const named = parseTemplateDefinition({
      name: "lembrete_agendamento",
      language: "pt_BR",
      parameter_format: "NAMED",
      components: [
        { type: "BODY", text: "Oi {{nome}}, dia {{data}} às {{hora}}." },
      ],
    }) as TemplateDefinition;
    const p = buildTemplatePayload(cfg, "Maria", occasion, [named]);
    expect(p?.processedParams.body).toEqual({
      nome: "Maria",
      data: "22/10/2026",
      hora: "14:30",
    });
  });

  test("a default with only body params is sent exactly as before kinds existed", () => {
    const legacy = readServiceWindowConfig({
      serviceWindow: {
        templateName: "reengajamento",
        templateParams: ["{{primeiro_nome}}"],
      },
    });
    expect(
      buildTemplatePayload(legacy, "Maria Silva", { kind: "followup" })
        ?.processedParams,
    ).toEqual({ body: { "1": "Maria" } });
  });
});

describe("templateChoiceProblem", () => {
  const choice = (over: Partial<TemplateChoice>): TemplateChoice => ({
    name: "lembrete_agendamento",
    language: "pt_BR",
    category: "UTILITY",
    params: ["a", "b", "c"],
    headerParams: ["d"],
    buttonParams: ["", "e"],
    content: null,
    ...over,
  });

  test("a choice that matches the definition passes", () => {
    expect(templateChoiceProblem(choice({}), DEFS)).toBeNull();
  });

  test("each mismatch names its own key", () => {
    const key = (over: Partial<TemplateChoice>) =>
      templateChoiceProblem(choice(over), DEFS)?.key;
    expect(key({ name: "nope" })).toBe("serviceWindowTemplateNotFound");
    expect(key({ language: "en_US" })).toBe("serviceWindowTemplateLanguage");
    expect(key({ params: ["a", "b"] })).toBe("serviceWindowTemplateBodyCount");
    expect(key({ headerParams: [] })).toBe("serviceWindowTemplateHeaderCount");
    expect(key({ buttonParams: ["", "e", "f"] })).toBe(
      "serviceWindowTemplateButtonCount",
    );
    expect(key({ buttonParams: [] })).toBe(
      "serviceWindowTemplateButtonNeedsSuffix",
    );
    expect(key({ buttonParams: ["x", "e"] })).toBe(
      "serviceWindowTemplateButtonTakesNone",
    );
  });

  test("the language matches without regard to case", () => {
    expect(
      templateChoiceProblem(choice({ language: "PT_br" }), DEFS),
    ).toBeNull();
  });

  test("a media header is refused, since nothing fills it", () => {
    const media = parseTemplateDefinition({
      name: "promo",
      language: "pt_BR",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Oi" },
      ],
    }) as TemplateDefinition;
    expect(
      templateChoiceProblem(
        choice({
          name: "promo",
          params: [],
          headerParams: [],
          buttonParams: [],
        }),
        [media],
      )?.key,
    ).toBe("serviceWindowTemplateMediaHeader");
  });
});

describe("misplacedAppointmentVar", () => {
  test("allowed on reminders, refused on the default and on other kinds", () => {
    expect(
      misplacedAppointmentVar(
        readServiceWindowConfig({
          serviceWindow: {
            templates: { appointment_reminder: lembrete },
            reminderTemplates: { "24": lembrete },
          },
        }),
      ),
    ).toBeNull();
    expect(
      misplacedAppointmentVar(
        readServiceWindowConfig({
          serviceWindow: {
            templateName: "reengajamento",
            templateParams: ["{{data_agendamento}}"],
          },
        }),
      ),
    ).toEqual({ where: "serviceWindow", placeholder: "data_agendamento" });
    expect(
      misplacedAppointmentVar(
        readServiceWindowConfig({
          serviceWindow: {
            templates: {
              followup: { name: "x", buttonParams: ["{{ hora_agendamento }}"] },
            },
          },
        }),
      ),
    ).toEqual({
      where: "serviceWindow.templates.followup",
      placeholder: "hora_agendamento",
    });
  });
});
