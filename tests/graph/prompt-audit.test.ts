import { describe, expect, test } from "bun:test";
import {
  buildPromptVars,
  interpolatePromptVars,
  PROMPT_ALL_VARS,
} from "@/graph/prompt";
import { buildPromptAudit } from "@/graph/prompt-audit";

// Decision table for the rule that decides what the Logs page is allowed to keep of a turn's system
// prompt. The rule has exactly two inputs, where a piece of text came from and whether it
// resolved, so it is written out as a table rather than as prose: the operator's own
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
});

// The audited prompt and the prompt the model was actually given are two renderings of ONE template,
// so they have to answer the same placeholders; only a context variable's VALUE may differ between
// them. This fails when a rendering option is threaded into the turn and not into the audit, which
// leaves a log reporting an unresolved placeholder the model was handed a value for. It reads the
// names from `PROMPT_ALL_VARS` rather than listing them, so a variable kind added later is covered.
describe("the audit answers the same placeholders the model's prompt did", () => {
  const names = [...PROMPT_ALL_VARS].sort();
  // Bracketed so a name is matched whole: the audit rewrites a resolved context var as
  // `{{nome_contato: string(11)}}`, which must NOT read as the literal `{{nome_contato}}`.
  const literal = (name: string) => `[{{${name}}}]`;
  const template = names.map((n) => `${n}=${literal(n)}`).join("\u0001");
  const vars = buildPromptVars({
    contactName: "Maria Silva",
    contactEmail: "maria@example.com",
    contactPhone: "+5511999998888",
    inboxName: "WhatsApp",
    companyName: "Clínica Alfa",
    agentName: "Alfa",
  });
  // Every option has something to answer: 22:30 of the 20th in São Paulo is already the 21st
  // in UTC, the schedule is closed at that hour, and the triggering message is 90 minutes old.
  // Friday opens at 01:00, so the same instant is still closed in São Paulo (Thursday 22:30) and
  // already open in UTC (Friday 01:30): a rendering that read the grid in any zone but the
  // schedule's own answers {{next_open_at}} differently. With a 09:00 opening every day, both zones
  // would land on "Friday 09:00" in their own wall clock and the row could not tell them apart.
  const opts = {
    timezone: "America/Sao_Paulo",
    now: new Date("2026-08-21T01:30:00Z"),
    availability: {
      schedule: {
        timezone: "America/Sao_Paulo",
        windows: [1, 2, 3, 4, 5].map((day) => ({
          day,
          start: day === 5 ? "01:00" : "09:00",
          end: "18:00",
        })),
        exceptions: [],
      },
    },
    messageAt: new Date("2026-08-21T00:00:00Z"),
  };
  const real = interpolatePromptVars(template, vars, opts);
  const audit = buildPromptAudit({ template, vars, opts, sections: [] });
  const answers = (rendered: string) =>
    Object.fromEntries(
      rendered.split("\u0001").map((row) => {
        const at = row.indexOf("=");
        return [row.slice(0, at), row.slice(at + 1)];
      }),
    );
  const realAnswers = answers(real);
  const auditAnswers = answers(audit);

  // Anchors the rows below: without this they would also pass if BOTH renderings stopped resolving.
  test("every known variable resolves in the model's own prompt", () => {
    expect(names.filter((n) => real.includes(literal(n)))).toEqual([]);
  });

  // A context value is masked to its name and length; every other answer is the model's own, word
  // for word.
  for (const name of names) {
    test(`{{${name}}}`, () => {
      const answer = realAnswers[name] as string;
      expect(auditAnswers[name]).toBe(
        name in vars ? `[{{${name}: string(${answer.length - 2})}}]` : answer,
      );
    });
  }
});
