import { describe, expect, test } from "bun:test";
import {
  buildPromptVars,
  interpolatePromptVars,
  PROMPT_ALL_VARS,
} from "@/graph/prompt";
import { buildPromptAudit } from "@/graph/prompt-audit";

// Decision table for the rule that decides what the Logs page is allowed to keep of a turn's system
// prompt (issue #141). The rule has exactly two inputs, where a piece of text came from and
// whether it resolved, so it is written out as a table rather than as prose: the operator's own
// words stay, a value that came from a person becomes its name and its length, a clock value stays
// because no person authored it, and an unresolved placeholder stays exactly as it was typed.

const VARS = {
  nome_contato: "Maria Silva",
  telefone_contato: "+5511999998888",
  nome_empresa: "Clínica Alfa",
};

const NOW = new Date("2026-08-20T15:07:00Z");
const TZ = "UTC";
// The same shape the turn renders with. `schedule: null` is a real state, not a stub: it is what an
// agent with no Availability configured has, and the gate reads it as always on.
const OPTS = {
  timezone: TZ,
  now: NOW,
  availability: { schedule: null },
};

describe("buildPromptAudit", () => {
  const cases: Array<{
    name: string;
    template: string;
    expected: string;
  }> = [
    {
      name: "text with no placeholder is untouched",
      template: "Atenda com educação. Nunca prometa prazo.",
      expected: "Atenda com educação. Nunca prometa prazo.",
    },
    {
      name: "a resolved context variable becomes its name and length",
      template: "Você atende {{nome_contato}}.",
      expected: "Você atende {{nome_contato: string(11)}}.",
    },
    {
      name: "every context variable is masked, not only the contact's",
      template: "{{nome_empresa}} atende {{telefone_contato}}.",
      expected:
        "{{nome_empresa: string(12)}} atende {{telefone_contato: string(14)}}.",
    },
    {
      name: "a context variable that resolved EMPTY still reports as resolved",
      template: "Olá {{primeiro_nome}}.",
      expected: "Olá {{primeiro_nome: string(0)}}.",
    },
    {
      name: "a time variable keeps its value: no person authored it",
      template: "Agora são {{hora_atual}}.",
      expected: "Agora são 15:00.",
    },
    {
      name: "a schedule variable keeps its value: the operator configured it, not a person in the conversation",
      template:
        "Estamos abertos? {{esta_aberto}}. Horário: {{horario_atendimento}}.",
      expected: "Estamos abertos? sim. Horário: sempre aberto.",
    },
    {
      name: "an unknown placeholder stays literal, exactly as the prompt leaves it",
      template: "Olá {{cliente_vip}}.",
      expected: "Olá {{cliente_vip}}.",
    },
    {
      name: "the same variable twice is masked twice",
      template: "{{nome_contato}} / {{nome_contato}}",
      expected: "{{nome_contato: string(11)}} / {{nome_contato: string(11)}}",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        buildPromptAudit({
          // `primeiro_nome` is absent from VARS on purpose in one row, so add it here as the empty
          // string the real builder produces for a contact with no name.
          template: c.template,
          vars: { ...VARS, primeiro_nome: "" },
          opts: OPTS,
          sections: [],
        }),
      ).toBe(c.expected);
    });
  }

  // The blocks appended after the prompt are the other half: their VALUES are the customer's, and
  // their keys are the operator's own selection, which is why the keys can be named.
  test("an appended block is reduced to its label, its selected keys and its size", () => {
    const out = buildPromptAudit({
      template: "Seja breve.",
      vars: VARS,
      opts: OPTS,
      sections: [
        {
          label: "atributos",
          keys: ["conversation:numero_processo", "contact:cpf"],
          text: "<attribute_values>…12345678900…</attribute_values>",
        },
      ],
    });
    expect(out).toBe(
      'Seja breve.\n\n<atributos chaves="conversation:numero_processo contact:cpf" chars="50"/>',
    );
    expect(out).not.toContain("12345678900");
  });

  test("a block with no operator selection reports only its label and size", () => {
    expect(
      buildPromptAudit({
        template: "Seja breve.",
        vars: VARS,
        opts: OPTS,
        sections: [{ label: "agendamentos", text: "18/09 14:00 Maria S." }],
      }),
    ).toBe('Seja breve.\n\n<agendamentos chars="20"/>');
  });

  // The audited prompt is built after the real one, with a DB read in between, so the instant has to
  // come from the caller rather than from each rendering's own `new Date()`. `now` is required on
  // purpose; this pins the behavior that makes requiring it worth anything.
  test("the instant comes from the caller, never from the call", () => {
    const render = (now: Date) =>
      buildPromptAudit({
        template: "Agora são {{hora_atual_exata:HH:mm:ss}}.",
        vars: VARS,
        opts: { ...OPTS, now },
        sections: [],
      });
    expect(render(NOW)).toBe(render(NOW));
    expect(render(NOW)).toBe("Agora são 15:07:00.");
    // A different instant renders differently, so the assertion above is about the input and not
    // about the variable being inert.
    expect(render(new Date("2026-08-20T15:08:30Z"))).toBe(
      "Agora são 15:08:30.",
    );
  });

  test("no blocks means nothing is appended", () => {
    expect(
      buildPromptAudit({
        template: "Seja breve.",
        vars: VARS,
        opts: OPTS,
        sections: [],
      }),
    ).toBe("Seja breve.");
  });
});

// The audited prompt and the prompt the model was actually given are two renderings of ONE template,
// so they have to answer the same placeholders; only a context variable's VALUE may differ between
// them. This is the test that fails when a rendering option is threaded into the turn and not into
// the audit, which is how the schedule variables came to resolve for the model and stay literal in
// the row — a log reporting an unresolved placeholder the model had been handed a value for.
//
// It reads the names from `PROMPT_ALL_VARS` rather than listing them, so a variable kind added later
// is inside this test without anyone remembering to add it.
describe("the audit answers the same placeholders the model's prompt did", () => {
  const names = [...PROMPT_ALL_VARS].sort();
  // Bracketed so a name is matched whole: the audit rewrites a resolved context var as
  // `{{nome_contato: string(11)}}`, which must NOT read as the literal `{{nome_contato}}`.
  const literal = (name: string) => `[{{${name}}}]`;
  const template = names.map((n) => `${n}=${literal(n)}`).join(" ");
  const vars = buildPromptVars({
    contactName: "Maria Silva",
    contactEmail: "maria@example.com",
    contactPhone: "+5511999998888",
    inboxName: "WhatsApp",
    companyName: "Clínica Alfa",
    agentName: "Alfa",
  });
  const real = interpolatePromptVars(template, vars, OPTS);
  const audit = buildPromptAudit({ template, vars, opts: OPTS, sections: [] });

  // Anchors the rows below: without this they would also pass if BOTH renderings stopped resolving.
  test("every known variable resolves in the model's own prompt", () => {
    expect(names.filter((n) => real.includes(literal(n)))).toEqual([]);
  });

  for (const name of names) {
    test(`{{${name}}}`, () => {
      expect(audit.includes(literal(name))).toBe(real.includes(literal(name)));
    });
  }
});
