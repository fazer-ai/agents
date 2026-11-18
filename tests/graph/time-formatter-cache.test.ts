import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { datedHistory } from "@/graph/history-dates";
import { sentAtStamp } from "@/graph/markers";
import { partsInTimezone } from "@/graph/time";

// The dated history asks `partsInTimezone` once per message a person sent, on every model call, so the
// formatter it reads with has to be built once per (locale, timezone) and not once per message.

const RealDateTimeFormat = Intl.DateTimeFormat;
let built = 0;

beforeEach(() => {
  built = 0;
  Intl.DateTimeFormat = new Proxy(RealDateTimeFormat, {
    construct(target, args) {
      built++;
      return Reflect.construct(target, args);
    },
    apply(target, self, args) {
      built++;
      return Reflect.apply(target, self, args);
    },
  });
});

afterEach(() => {
  Intl.DateTimeFormat = RealDateTimeFormat;
});

function history(size: number, zoneTag: number): HumanMessage[] {
  const t0 = Date.parse("2026-03-01T02:30:00Z") + zoneTag;
  return Array.from(
    { length: size },
    (_, i) =>
      new HumanMessage({
        content: `msg ${i}`,
        additional_kwargs: sentAtStamp(new Date(t0 + i * 3_600_000)),
      }),
  );
}

describe("the formatter behind partsInTimezone", () => {
  test("is built at most once per timezone, however long the history", () => {
    const tz = "Asia/Kathmandu";
    datedHistory(history(10, 0), tz);
    const afterTen = built;
    datedHistory(history(400, 1), tz);
    expect(afterTen).toBeLessThanOrEqual(1);
    expect(built).toBe(afterTen);
  });

  test("a second timezone gets its own formatter, and the first is not reused for it", () => {
    const at = new Date("2026-11-01T03:15:00Z");
    const sp = partsInTimezone(at, "America/Sao_Paulo");
    const ny = partsInTimezone(at, "America/New_York");
    const spAgain = partsInTimezone(at, "America/Sao_Paulo");
    expect(sp).toEqual({
      YYYY: "2026",
      MM: "11",
      DD: "01",
      HH: "00",
      mm: "15",
      ss: "00",
      weekday: "domingo",
    });
    expect(ny.HH).toBe("23");
    expect(ny.DD).toBe("31");
    expect(spAgain).toEqual(sp);
    expect(partsInTimezone(at, "America/New_York", "en-US").weekday).toBe(
      "Saturday",
    );
  });

  test("reads the same parts a fresh formatter reads, across a DST change", () => {
    const tz = "America/Santiago";
    for (let h = 0; h < 72; h++) {
      const at = new Date(Date.parse("2026-09-05T00:00:00Z") + h * 3_600_000);
      const fresh = new RealDateTimeFormat("pt-BR", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(at);
      const get = (t: string) => fresh.find((p) => p.type === t)?.value;
      const p = partsInTimezone(at, tz);
      expect([p.YYYY, p.MM, p.DD, p.HH, p.mm]).toEqual([
        get("year") ?? "",
        get("month") ?? "",
        get("day") ?? "",
        get("hour") ?? "",
        get("minute") ?? "",
      ]);
    }
  });

  test("is bounded: many distinct spellings clear the cache instead of growing it", () => {
    const at = new Date("2026-11-01T03:15:00Z");
    partsInTimezone(at, "Europe/Lisbon");
    built = 0;
    partsInTimezone(at, "Europe/Lisbon");
    expect(built).toBe(0);
    const zones = Intl.supportedValuesOf("timeZone");
    for (const locale of ["en-US", "pt-PT"]) {
      for (const tz of zones) partsInTimezone(at, tz, locale);
    }
    expect(zones.length * 2).toBeGreaterThan(512);
    built = 0;
    partsInTimezone(at, "Europe/Lisbon");
    expect(built).toBe(1);
  });

  test("a timezone Intl rejects throws on every call, not only the first", () => {
    const at = new Date();
    expect(() => partsInTimezone(at, "Not/AZone")).toThrow(RangeError);
    expect(() => partsInTimezone(at, "Not/AZone")).toThrow(RangeError);
  });
});
