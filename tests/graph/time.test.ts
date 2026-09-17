import { describe, expect, test } from "bun:test";
import {
  formatWithPattern,
  partsInTimezone,
  roundDownLocalMinutes,
  zonedWallClockToInstant,
} from "@/graph/time";

// O piso por EPOCH, que é o que a fonte fazia antes desta rodada e não é mais exportado por ninguém:
// fica aqui porque é o CONTROLE do teste de Kathmandu abaixo, e é a única coisa que demonstra por que
// a função local precisou existir.
function pisoPorEpoch(date: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

describe("formatWithPattern / partsInTimezone", () => {
  // 2026-06-13T17:05:00Z is 14:05 in São Paulo (UTC-3).
  const d = new Date("2026-06-13T17:05:00.000Z");

  test("substitutes tokens in the target timezone", () => {
    expect(formatWithPattern(d, "America/Sao_Paulo", "YYYY-MM-DD HH:mm")).toBe(
      "2026-06-13 14:05",
    );
    expect(formatWithPattern(d, "America/Sao_Paulo", "DD/MM")).toBe("13/06");
  });

  test("MM (month) and mm (minute) are distinct tokens", () => {
    expect(formatWithPattern(d, "America/Sao_Paulo", "MM:mm")).toBe("06:05");
  });

  test("respects the timezone (UTC vs São Paulo)", () => {
    expect(partsInTimezone(d, "UTC").HH).toBe("17");
    expect(partsInTimezone(d, "America/Sao_Paulo").HH).toBe("14");
  });
});

describe("zonedWallClockToInstant", () => {
  test("round-trips a wall-clock through its own timezone", () => {
    // The instant chosen must format back to exactly the wall-clock in that tz.
    for (const tz of ["America/Sao_Paulo", "UTC", "Asia/Tokyo"]) {
      const inst = zonedWallClockToInstant("2026-03-10T23:00", tz);
      expect(inst).not.toBeNull();
      expect(formatWithPattern(inst as Date, tz, "YYYY-MM-DD HH:mm")).toBe(
        "2026-03-10 23:00",
      );
    }
  });

  test("São Paulo (UTC-3) maps to the right absolute instant", () => {
    // 23:00 in São Paulo is 02:00 UTC the next day.
    expect(
      zonedWallClockToInstant(
        "2026-03-10T23:00",
        "America/Sao_Paulo",
      )?.toISOString(),
    ).toBe("2026-03-11T02:00:00.000Z");
  });

  test("accepts optional seconds and a space separator", () => {
    expect(
      zonedWallClockToInstant("2026-03-10 23:00:30", "UTC")?.toISOString(),
    ).toBe("2026-03-10T23:00:30.000Z");
  });

  test("returns null for an unparseable value", () => {
    expect(zonedWallClockToInstant("", "UTC")).toBeNull();
    expect(zonedWallClockToInstant("not-a-date", "UTC")).toBeNull();
    expect(zonedWallClockToInstant("2026-03-10", "UTC")).toBeNull();
  });
});

// (#685, rodada 6 da review) Arredondar o EPOCH não é arredondar o relógio local onde o offset do
// fuso não é múltiplo do slot. Em Asia/Kathmandu (+05:45), meia hora: 00:05 do dia 18 cai em 23:45
// do dia 17, então quem renderiza o resultado como "o momento atual" enuncia ONTEM, e quem raciocina
// a partir dele erra o dia. A data é o que torna isto carregador: o arredondamento existe para o
// cache do prompt, e mover a data local para comprar cache é trocar a resposta pelo cache.
describe("roundDownLocalMinutes", () => {
  test("floors the local wall clock, keeping the local date", () => {
    const now = new Date("2026-09-18T00:05:00+05:45");
    expect(
      formatWithPattern(
        roundDownLocalMinutes(now, "Asia/Kathmandu", 30),
        "Asia/Kathmandu",
        "DD/MM/YYYY HH:mm",
      ),
    ).toBe("18/09/2026 00:00");
    // O controle: o arredondamento por epoch, que é o que estava aqui, responde o dia anterior.
    expect(
      formatWithPattern(
        pisoPorEpoch(now, 30),
        "Asia/Kathmandu",
        "DD/MM/YYYY HH:mm",
      ),
    ).toBe("17/09/2026 23:45");
  });

  test("floors to the slot in an ordinary zone, on both sides of the half hour", () => {
    for (const [iso, esperado] of [
      ["2026-09-18T14:00:00-03:00", "14:00"],
      ["2026-09-18T14:29:59-03:00", "14:00"],
      ["2026-09-18T14:30:00-03:00", "14:30"],
      ["2026-09-18T14:59:00-03:00", "14:30"],
    ] as const) {
      expect(
        formatWithPattern(
          roundDownLocalMinutes(new Date(iso), "America/Sao_Paulo", 30),
          "America/Sao_Paulo",
          "HH:mm",
        ),
      ).toBe(esperado);
    }
  });

  // (rodadas 7 e 8 da review) As duas falhas do caminho que RECONSTRUÍA o wall clock e convertia de
  // volta. `zonedWallClockToInstant` corrige o offset uma vez só, a partir de um palpite em UTC, e
  // num dia de virada responde com o offset do lado errado: no fall-back, 02:15 EST arredondado para
  // a meia hora voltava como 01:00 local, 75 minutos atrás, com um slot de 30; e no spring-forward o
  // 03:00 reconstruído caía À FRENTE do instante, o que fazia a guarda contra isso devolver o
  // instante SEM piso (03:15), perdendo justamente a estabilidade da função. O piso hoje é subtraído
  // do instante, então nenhuma das duas existe: a distância é o resto, sempre menor que o slot.
  test("floors a fall-back hour without falling into the previous slot", () => {
    const d = new Date("2026-11-01T02:15:00-05:00");
    const r = roundDownLocalMinutes(d, "America/New_York", 30);
    expect(formatWithPattern(r, "America/New_York", "DD/MM/YYYY HH:mm")).toBe(
      "01/11/2026 02:00",
    );
    expect(d.getTime() - r.getTime()).toBe(15 * 60_000);
  });

  test("floors a spring-forward hour instead of giving up on the floor", () => {
    const d = new Date("2026-03-08T03:15:00-04:00");
    const r = roundDownLocalMinutes(d, "America/New_York", 30);
    expect(r.getTime()).toBeLessThanOrEqual(d.getTime());
    expect(formatWithPattern(r, "America/New_York", "DD/MM/YYYY HH:mm")).toBe(
      "08/03/2026 03:00",
    );
  });

  // A hora repetida do fall-back é DOIS instantes com o mesmo wall clock, e cada um tem o seu piso:
  // o que a função nunca faz é responder o primeiro 01:30 para quem está no segundo 01:45, que é uma
  // hora inteira de erro. É o mesmo motivo pelo qual o piso não passa por wall clock.
  test("the repeated hour has two floors, one per instant", () => {
    const antes = new Date("2026-11-01T01:45:00-04:00");
    const depois = new Date("2026-11-01T01:45:00-05:00");
    expect(depois.getTime() - antes.getTime()).toBe(60 * 60_000);
    for (const d of [antes, depois]) {
      const r = roundDownLocalMinutes(d, "America/New_York", 30);
      expect(formatWithPattern(r, "America/New_York", "HH:mm")).toBe("01:30");
      expect(d.getTime() - r.getTime()).toBe(15 * 60_000);
    }
    expect(
      roundDownLocalMinutes(depois, "America/New_York", 30).getTime() -
        roundDownLocalMinutes(antes, "America/New_York", 30).getTime(),
    ).toBe(60 * 60_000);
  });

  // (rodada 7 da review) O slot conta a partir da MEIA-NOITE local, não do minuto da hora: 120
  // flooreando só os minutos reiniciaria a cada hora e se comportaria como 60, e 45 significaria
  // outra coisa em cada hora. `get_current_time` aceita qualquer inteiro positivo aqui.
  test("the slot counts from local midnight, so it survives an hour boundary", () => {
    const d = new Date("2026-09-18T15:40:00Z");
    for (const [slot, esperado] of [
      [120, "14:00"],
      [45, "15:00"],
      [90, "15:00"],
      [30, "15:30"],
    ] as const) {
      expect(
        formatWithPattern(
          roundDownLocalMinutes(d, "UTC", slot),
          "UTC",
          "HH:mm",
        ),
      ).toBe(esperado);
    }
  });

  // As propriedades que fazem esta função ser usável como "o momento atual" num prompt, sobre uma
  // varredura de fusos exóticos (inclusive os de :45 e :30), slots e horas do dia: 7056 casos. A
  // terceira é a que a rodada 8 acrescentou, e é a que o caminho antigo violava em 75 minutos: a
  // resposta nunca está mais longe que o próprio slot, então ela sempre nomeia o slot corrente ou,
  // atravessando uma virada, o vizinho — nunca um ponto a uma hora e meia de distância.
  test("over a sweep of zones and slots: never forward, never another local day, never farther than the slot", () => {
    let violacoes = 0;
    let n = 0;
    for (const tz of [
      "America/Sao_Paulo",
      "America/New_York",
      "Asia/Kathmandu",
      "Australia/Lord_Howe",
      "UTC",
      "Pacific/Chatham",
      "Europe/Lisbon",
    ]) {
      for (const slot of [5, 15, 30, 45, 60, 90, 120]) {
        for (let h = 0; h < 24; h++) {
          for (const mm of [0, 7, 29, 30, 44, 59]) {
            // 8 de março de 2026 é dia de virada em America/New_York, que é o caso difícil.
            const d = new Date(Date.UTC(2026, 2, 8, h, mm));
            const r = roundDownLocalMinutes(d, tz, slot);
            n += 1;
            if (
              r.getTime() > d.getTime() ||
              d.getTime() - r.getTime() >= slot * 60_000 ||
              formatWithPattern(d, tz, "DD") !== formatWithPattern(r, tz, "DD")
            ) {
              violacoes += 1;
            }
          }
        }
      }
    }
    expect(n).toBe(7056);
    expect(violacoes).toBe(0);
  });

  // O motivo de a função existir: dois instantes dentro do mesmo slot têm que dar o MESMO instante,
  // senão cada turno monta um prompt diferente e o cache do provedor nunca casa (é o que `TIME_VARS`
  // diz sobre `TIME_ROUND_MINUTES`). Segundos e milissegundos entram nessa conta: sem zerá-los, dois
  // turnos a dez segundos de distância já divergem.
  test("every instant inside one slot floors to the same instant", () => {
    const base = new Date("2026-09-18T14:30:00-03:00");
    const esperado = base.getTime();
    for (const deslocamento of [
      0,
      1,
      999,
      10_000,
      61_000,
      29 * 60_000 + 59_999,
    ]) {
      const r = roundDownLocalMinutes(
        new Date(base.getTime() + deslocamento),
        "America/Sao_Paulo",
        30,
      );
      expect(r.getTime()).toBe(esperado);
    }
  });

  test("a slot of zero or less is the instant itself", () => {
    const d = new Date("2026-09-18T14:29:00-03:00");
    expect(roundDownLocalMinutes(d, "America/Sao_Paulo", 0)).toEqual(d);
    expect(roundDownLocalMinutes(d, "America/Sao_Paulo", -5)).toEqual(d);
  });
});
