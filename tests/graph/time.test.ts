import { describe, expect, test } from "bun:test";
import {
  flooredLocalParts,
  formatParts,
  formatPartsHuman,
  formatWithPattern,
  partsInTimezone,
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
describe("flooredLocalParts", () => {
  const at = (
    iso: string,
    tz: string,
    minutes: number,
    pattern = "DD/MM/YYYY HH:mm",
  ) => formatParts(flooredLocalParts(new Date(iso), tz, minutes), pattern);

  test("floors the local wall clock, keeping the local date", () => {
    const now = new Date("2026-09-18T00:05:00+05:45");
    expect(at(now.toISOString(), "Asia/Kathmandu", 30)).toBe(
      "18/09/2026 00:00",
    );
    // O controle: o piso por epoch, que é o que a fonte fazia antes, responde o dia anterior — o
    // offset de :45 não é um múltiplo da meia hora, então a fatia do epoch não é a do calendário.
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
      expect(at(iso, "America/Sao_Paulo", 30, "HH:mm")).toBe(esperado);
    }
  });

  // O slot conta da MEIA-NOITE local, não do minuto da hora: 120 flooreando só os minutos
  // reiniciaria a cada hora e se comportaria como 60, e 45 significaria outra coisa em cada hora.
  // `get_current_time` aceita qualquer inteiro positivo aqui.
  test("the slot counts from local midnight, so it survives an hour boundary", () => {
    for (const [slot, esperado] of [
      [120, "14:00"],
      [45, "15:00"],
      [90, "15:00"],
      [30, "15:30"],
    ] as const) {
      expect(at("2026-09-18T15:40:00Z", "UTC", slot, "HH:mm")).toBe(esperado);
    }
  });

  // As três formas em que a versão que devolvia INSTANTE errou, uma por rodada de review, e que esta
  // não tem como errar porque a data sai da leitura e a hora é aritmética inteira sobre ela.
  test("the three transition cases that broke the instant-returning versions", () => {
    // Rodada 8, fall-back: o round trip respondia 01:00, 75 minutos atrás num slot de 30.
    expect(at("2026-11-01T02:15:00-05:00", "America/New_York", 30)).toBe(
      "01/11/2026 02:00",
    );
    // Rodada 8, spring-forward: a guarda de avanço devolvia o instante SEM piso (03:15).
    expect(at("2026-03-08T03:15:00-04:00", "America/New_York", 30)).toBe(
      "08/03/2026 03:00",
    );
    // Rodada 10, dia cujo meia-noite local não existe (Santiago começa 6/set às 01:00): o piso por
    // subtração respondia o dia 5 às 23:00. A data agora é a lida, e a hora é o limite de slot —
    // 00:00 é uma hora que não aconteceu naquele dia, e é o preço declarado no comentário da função.
    expect(at("2026-09-06T01:15:00-03:00", "America/Santiago", 120)).toBe(
      "06/09/2026 00:00",
    );
  });

  // A hora repetida do fall-back é dois INSTANTES com o mesmo mostrador, e o piso é do mostrador:
  // os dois respondem 01:30, que é o que um relógio de parede diria nas duas vezes.
  test("the repeated hour reads the same on both passes, because the clock does", () => {
    const antes = "2026-11-01T01:45:00-04:00";
    const depois = "2026-11-01T01:45:00-05:00";
    expect(new Date(depois).getTime() - new Date(antes).getTime()).toBe(
      3_600_000,
    );
    for (const iso of [antes, depois]) {
      expect(at(iso, "America/New_York", 30, "HH:mm")).toBe("01:30");
    }
  });

  // O motivo de a função existir: dois instantes dentro do mesmo slot dão a MESMA leitura, senão
  // cada turno monta um prompt diferente e o cache do provedor nunca casa (é o que `TIME_VARS` diz
  // sobre `TIME_ROUND_MINUTES`). Segundos e milissegundos entram nessa conta.
  test("every instant inside one slot reads the same", () => {
    const base = new Date("2026-09-18T14:30:00-03:00");
    for (const deslocamento of [
      0,
      1,
      999,
      10_000,
      61_000,
      29 * 60_000 + 59_999,
    ]) {
      expect(
        formatParts(
          flooredLocalParts(
            new Date(base.getTime() + deslocamento),
            "America/Sao_Paulo",
            30,
          ),
          "DD/MM/YYYY HH:mm:ss",
        ),
      ).toBe("18/09/2026 14:30:00");
    }
  });

  // TODAS as propriedades no mesmo laço, e não só a que estava em disputa: as rodadas 7, 8 e 10
  // acharam três defeitos nesta função, cada um numa propriedade que a varredura da rodada anterior
  // não perguntava. Sobre fusos exóticos (inclusive os de :45 e :30), slots e horas do dia.
  test("over a sweep of zones, days and slots: the date is the one read, the time is a slot boundary, and it never runs ahead", () => {
    let violacoes = 0;
    let n = 0;
    for (const tz of [
      "America/Sao_Paulo",
      "America/New_York",
      "America/Santiago",
      "Asia/Kathmandu",
      "Australia/Lord_Howe",
      "Antarctica/Troll",
      "UTC",
      "Pacific/Chatham",
      "Europe/Lisbon",
    ]) {
      for (const slot of [15, 30, 45, 120]) {
        // Dias de virada nos dois hemisférios, mais um dia comum como controle.
        for (const [mes, dia] of [
          [3, 8],
          [9, 6],
          [11, 1],
          [10, 4],
          [6, 15],
        ] as const) {
          for (let h = 0; h < 24; h++) {
            for (const mm of [0, 29, 30, 59]) {
              const d = new Date(Date.UTC(2026, mes - 1, dia, h, mm, 37, 500));
              const lido = partsInTimezone(d, tz);
              const piso = flooredLocalParts(d, tz, slot);
              const minutosLidos = Number(lido.HH) * 60 + Number(lido.mm);
              const minutosPiso = Number(piso.HH) * 60 + Number(piso.mm);
              n += 1;
              if (
                // a data é a que foi lida, sempre: é a propriedade que o defeito da rodada 10 violava
                piso.YYYY !== lido.YYYY ||
                piso.MM !== lido.MM ||
                piso.DD !== lido.DD ||
                piso.weekday !== lido.weekday ||
                // a hora é um limite de slot, com segundo zerado
                minutosPiso % slot !== 0 ||
                piso.ss !== "00" ||
                // nunca à frente do relógio lido, e nunca mais de um slot atrás
                minutosPiso > minutosLidos ||
                minutosLidos - minutosPiso >= slot
              ) {
                violacoes += 1;
              }
            }
          }
        }
      }
    }
    // O grid é deliberadamente menor que o que já rodou aqui: a versão com 45.360 casos levava
    // 6,3s no runner do CI e estourava o timeout de 5s do bun, verde só nesta máquina. E a terceira
    // leitura que ela fazia por caso era uma falsa idempotência — chamar a função duas vezes com a
    // MESMA entrada mede determinismo, não que o piso de um piso seja ele mesmo, que esta assinatura
    // nem deixa expressar.
    expect(n).toBe(17280);
    expect(violacoes).toBe(0);
  });

  // `formatPartsHuman` remonta o instante em UTC só para entregar os números ao `Intl`, e é o que o
  // `get_current_time` usa desde que passou a ler o relógio uma vez e renderizar duas vezes das MESMAS
  // partes. A cerca é que o texto seja idêntico ao de ler o instante no fuso, que é o caminho antigo:
  // sem isso, a frase do cliente poderia ter mudado de forma sem ninguém notar.
  test("the human sentence from parts is the same text as reading the instant in the zone", () => {
    for (const tz of [
      "America/Sao_Paulo",
      "Asia/Kathmandu",
      "UTC",
      "Pacific/Chatham",
      "America/New_York",
    ]) {
      for (const iso of [
        "2026-09-18T14:47:31.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-11-01T05:30:00.000Z",
        "2026-03-08T07:15:00.000Z",
      ]) {
        const d = new Date(iso);
        const noFuso = new Intl.DateTimeFormat("pt-BR", {
          timeZone: tz,
          dateStyle: "full",
          timeStyle: "short",
        }).format(d);
        expect(formatPartsHuman(partsInTimezone(d, tz))).toBe(noFuso);
      }
    }
  });

  test("a slot of zero or less is the clock as read", () => {
    const d = new Date("2026-09-18T14:29:37-03:00");
    for (const slot of [0, -5]) {
      expect(
        formatParts(
          flooredLocalParts(d, "America/Sao_Paulo", slot),
          "HH:mm:ss",
        ),
      ).toBe("14:29:37");
    }
  });
});
