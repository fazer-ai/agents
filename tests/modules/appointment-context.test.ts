import { describe, expect, test } from "bun:test";
import {
  buildAppointmentContextSection,
  parseStartMs,
} from "@/modules/appointments/context";

// The projection of reminder JOBS into "live appointments" used to live here. It is gone with the
// model it projected: an appointment is a row of its own now, and liveness is one predicate over one
// column (`cancelled_at IS NULL AND start_at > now`), asserted against a real database in
// tests/modules/appointment-context-db.test.ts. Several of the cases this file used to need are no
// longer expressible — a row with no event id, a start compared as a string across offsets — which
// is what the change bought.

const FUTURE = "2026-08-08T10:00:00-03:00";
// O relógio e o fuso do turno, que o bloco agora enuncia (#685). Fixos, porque um bloco que carrega
// o instante corrente afirma uma data, e teste que lê o relógio da máquina afirma outra a cada
// rodada.
const NOW = new Date("2026-08-07T14:10:00-03:00");
const TZ = "America/Sao_Paulo";

describe("buildAppointmentContextSection", () => {
  const event = {
    eventId: "ev_1",
    calendarId: "cal@group.calendar.google.com",
    calendarLabel: "Agenda Dra. Ana",
    provider: "google_calendar",
    startISO: FUTURE,
    summary: "Consulta",
  };

  test("no events → no section", () => {
    expect(buildAppointmentContextSection([], true, NOW, TZ)).toBeNull();
  });

  test("carries event_id, calendar_id, label, start and summary as XML attributes", () => {
    const s = buildAppointmentContextSection([event], true, NOW, TZ);
    expect(s).toContain("## Agendamentos deste atendimento");
    expect(s).toContain('event_id="ev_1"');
    expect(s).toContain('calendar_id="cal@group.calendar.google.com"');
    expect(s).toContain('calendar="Agenda Dra. Ana"');
    expect(s).toContain(`start="${FUTURE}"`);
    expect(s).toContain('summary="Consulta"');
  });

  test("hostile summary is escaped (block stays well-formed)", () => {
    const s = buildAppointmentContextSection(
      [{ ...event, summary: 'x"/><injected foo="bar' }],
      true,
      NOW,
      TZ,
    );
    expect(s).not.toContain("<injected");
    expect(s).toContain("&lt;injected");
  });

  test("tool affordance only when the calendar write tools are granted", () => {
    const withTools = buildAppointmentContextSection([event], true, NOW, TZ);
    expect(withTools).toContain("calendar_update_event");
    expect(withTools).toContain("event_id");
    const readOnly = buildAppointmentContextSection([event], false, NOW, TZ);
    expect(readOnly).not.toContain("calendar_update_event");
  });

  // `canOperate` answers for the TOOLSET and the provider answers for the APPOINTMENT, and an
  // operator who declares bookings from their own system (issue #352) while also granting the
  // Calendar toolpack has both in one block. Pointing the model at calendar_cancel_event with a
  // Feegow id is a call that cannot work, made against a booking that is real.
  const foreign = {
    ...event,
    eventId: "42",
    provider: "feegow",
    calendarId: null,
    calendarLabel: null,
  };

  test("a foreign appointment is never pointed at the Google tools", () => {
    const s = buildAppointmentContextSection([foreign], true, NOW, TZ);
    expect(s).toContain('event_id="42"');
    expect(s).toContain('source="feegow"');
    // No calendar exists, so no calendar id is invented for it.
    expect(s).not.toContain("calendar_id=");
    expect(s).not.toContain("para reagendar use calendar_update_event");
    expect(s).toContain("nunca calendar_update_event");
  });

  test("a Google appointment carries no source attribute", () => {
    const s = buildAppointmentContextSection([event], true, NOW, TZ);
    expect(s).not.toContain("source=");
    expect(s).not.toContain("nunca calendar_update_event");
  });

  test("a mixed block scopes each instruction to the appointments it can reach", () => {
    const s = buildAppointmentContextSection([event, foreign], true, NOW, TZ);
    // The Google half keeps its affordance...
    expect(s).toContain("Para os agendamentos que trazem calendar_id");
    expect(s).toContain("calendar_update_event");
    // ...and the foreign half is fenced off from it in the same paragraph.
    expect(s).toContain("nunca calendar_update_event");
    expect(s).toContain('source="feegow"');
  });

  test("without the calendar tools, a foreign appointment says nothing about Google", () => {
    const s = buildAppointmentContextSection([foreign], false, NOW, TZ);
    expect(s).not.toContain("Você NÃO tem ferramentas do Google Calendar aqui");
    expect(s).toContain("outro sistema");
  });
});

// NOTE: parseStartMs pins offset-less startISO values to UTC — the same rule the sweep SQL mirrors —
// so the JS and Postgres liveness decisions cannot diverge when app and DB time zones differ.
describe("parseStartMs", () => {
  test("all-day date parses as UTC midnight", () => {
    expect(parseStartMs("2026-06-13")).toBe(Date.parse("2026-06-13T00:00:00Z"));
  });

  test("an offset-less datetime is pinned to UTC (host-TZ independent)", () => {
    expect(parseStartMs("2026-06-13T12:00:00")).toBe(
      Date.parse("2026-06-13T12:00:00Z"),
    );
  });

  test("explicit offsets and Z are honored unchanged", () => {
    expect(parseStartMs("2026-06-13T12:00:00-03:00")).toBe(
      Date.parse("2026-06-13T15:00:00Z"),
    );
    expect(parseStartMs("2026-06-13T12:00:00Z")).toBe(
      Date.parse("2026-06-13T12:00:00Z"),
    );
  });

  test("garbage stays NaN (fail-safe not-future)", () => {
    expect(Number.isNaN(parseStartMs("amanhã de manhã"))).toBe(true);
    expect(Number.isNaN(parseStartMs(""))).toBe(true);
  });

  // NOTE: Date.parse would roll these over (Feb 30 → Mar 2) while the sweep's pg_input_is_valid
  // rejects them — NaN keeps the two liveness decisions in agreement.
  test("impossible calendar dates are NaN, not rolled over", () => {
    expect(Number.isNaN(parseStartMs("2026-02-30"))).toBe(true);
    expect(Number.isNaN(parseStartMs("2026-04-31T12:00:00"))).toBe(true);
    expect(Number.isNaN(parseStartMs("2023-02-29T10:00:00Z"))).toBe(true);
    expect(Number.isNaN(parseStartMs("2024-02-29"))).toBe(false);
    // NOTE: Years below 0100 are valid — the guard must not let Date.UTC remap them to 19xx.
    expect(parseStartMs("0099-02-28")).toBe(Date.parse("0099-02-28T00:00:00Z"));
  });
});

// (#685) O bloco enuncia datas absolutas, e o turno que as lê não sabe que dia é hoje: o instante
// corrente só chega a um prompt quando o operador digitou `{{data_atual}}` ou uma irmã. Medido
// contra a API real, numa thread cuja mensagem anterior dizia "amanhã" para um compromisso que
// tinha virado hoje: 6 de 10 respostas repetiam "amanhã", e com esta linha no bloco, 0 de 10.
describe("buildAppointmentContextSection: o instante corrente (#685)", () => {
  const event = {
    eventId: "ev_1",
    calendarId: "cal@group.calendar.google.com",
    calendarLabel: "Agenda Dra. Ana",
    provider: "google_calendar",
    startISO: FUTURE,
    summary: "Consulta",
  };

  test("o bloco diz o momento atual, no fuso que recebeu", () => {
    const s = buildAppointmentContextSection([event], true, NOW, TZ) as string;
    expect(s).toContain("Momento atual deste atendimento: 07/08/2026 14:00");
    expect(s).toContain("(America/Sao_Paulo)");
    // E diz para que ele serve, que é a metade que o modelo precisa: sem isso a linha é um dado
    // solto ao lado de outro, e a palavra relativa continua vindo do histórico.
    expect(s).toContain("hoje, amanhã ou outro dia");
  });

  // Arredondado na mesma meia hora das variáveis de prompt, e pelo mesmo motivo que o TIME_VARS
  // documenta: um valor que muda a cada minuto derruba o cache do prompt em todo turno. O bloco
  // inteiro é prefixo cacheado, então aqui isso custaria em cada conversa com compromisso vivo.
  test("o momento é arredondado na meia hora, como {{data_hora_atual}}", () => {
    for (const [iso, esperado] of [
      ["2026-08-07T14:00:00-03:00", "14:00"],
      ["2026-08-07T14:29:59-03:00", "14:00"],
      ["2026-08-07T14:30:00-03:00", "14:30"],
      ["2026-08-07T14:59:00-03:00", "14:30"],
    ] as const) {
      expect(
        buildAppointmentContextSection([event], true, new Date(iso), TZ),
      ).toContain(`Momento atual deste atendimento: 07/08/2026 ${esperado}`);
    }
  });

  // O fuso é o que chega, não o default: é o mesmo par (instante, fuso) que as variáveis de prompt
  // renderizam, e duas renderizações do mesmo relógio discordando dentro de um prompt é o defeito,
  // não o conserto.
  test("o fuso é o do turno, não o padrão do produto", () => {
    const s = buildAppointmentContextSection(
      [event],
      true,
      new Date("2026-08-07T14:00:00-03:00"),
      "Europe/Lisbon",
    ) as string;
    expect(s).toContain("Momento atual deste atendimento: 07/08/2026 18:00");
    expect(s).toContain("(Europe/Lisbon)");
  });
});
