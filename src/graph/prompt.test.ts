import { describe, expect, it } from "bun:test";
import {
  findExactTimeVarUsages,
  interpolatePromptVars,
  isKnownPromptVar,
  PROMPT_MESSAGE_DATE_VARS_DISPLAY,
  TIME_ROUND_MINUTES,
  timeVarKind,
} from "./prompt";

describe("timeVarKind", () => {
  it("marks the slot-floored time vars as rounded", () => {
    expect(timeVarKind("hora_atual")).toBe("rounded");
    expect(timeVarKind("current_time")).toBe("rounded");
    expect(timeVarKind("data_hora_atual")).toBe("rounded");
  });
  it("marks the exact time-of-day vars as exact", () => {
    expect(timeVarKind("hora_atual_exata")).toBe("exact");
    expect(timeVarKind("current_time_exact")).toBe("exact");
  });
  it("marks date-only vars as date (stable within a day)", () => {
    expect(timeVarKind("data_atual")).toBe("date");
    expect(timeVarKind("current_date")).toBe("date");
  });
  it("returns null for non-time and unknown vars", () => {
    expect(timeVarKind("nome_contato")).toBeNull();
    expect(timeVarKind("desconhecida")).toBeNull();
  });
});

describe("findExactTimeVarUsages", () => {
  it("flags an exact time var and suggests its rounded sibling", () => {
    expect(findExactTimeVarUsages("Agora são {{hora_atual_exata}}.")).toEqual([
      { name: "hora_atual_exata", suggestion: "hora_atual" },
    ]);
    expect(findExactTimeVarUsages("Now: {{current_time_exact}}")).toEqual([
      { name: "current_time_exact", suggestion: "current_time" },
    ]);
  });
  it("ignores rounded, date and non-time vars", () => {
    expect(
      findExactTimeVarUsages("{{hora_atual}} {{data_atual}} {{nome_contato}}"),
    ).toEqual([]);
  });
  it("dedupes repeated usages of the same var", () => {
    expect(
      findExactTimeVarUsages("{{hora_atual_exata}} … {{hora_atual_exata}}"),
    ).toEqual([{ name: "hora_atual_exata", suggestion: "hora_atual" }]);
  });
});

describe("interpolatePromptVars time rounding", () => {
  // 14:37 is off the 30-min slot, so rounded vs exact must differ (the caching contract).
  const now = new Date("2026-06-18T14:37:00-03:00");
  it("floors a rounded time var to the slot", () => {
    expect(interpolatePromptVars("{{hora_atual}}", {}, { now })).toBe("14:30");
  });
  it("keeps an exact time var precise", () => {
    expect(interpolatePromptVars("{{hora_atual_exata}}", {}, { now })).toBe(
      "14:37",
    );
  });
  it("defaults to a 30-minute rounding slot", () => {
    expect(TIME_ROUND_MINUTES).toBe(30);
  });
});

// ISSUE #749. The wording table, kept here because the end-to-end files prove the SEAM (the instant
// reaching the prompt) and would be a slow place to enumerate boundaries. The steps are minutes →
// hours → days, and each boundary is asserted on both sides: a unit that only checks the middle of a
// range passes with the comparison flipped.
describe("interpolatePromptVars message age", () => {
  const now = new Date("2026-09-20T12:00:00-03:00");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const age = (messageAt: Date | null, tpl = "{{idade_ultima_mensagem}}") =>
    interpolatePromptVars(tpl, {}, { now, messageAt });
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("says just now under a minute, and minutes from the first one", () => {
    expect(age(ago(59 * SEC))).toBe("agora mesmo");
    expect(age(ago(MIN))).toBe("há 1 minuto");
    expect(age(ago(59 * MIN))).toBe("há 59 minutos");
  });
  it("switches to hours at the hour, and keeps them for two days", () => {
    expect(age(ago(HOUR))).toBe("há 1 hora");
    expect(age(ago(47 * HOUR))).toBe("há 47 horas");
  });
  // Two days and not one: "há 36 horas" is a more useful answer than "há 1 dia", and the step only
  // earns the coarser unit once the number of hours stops being readable.
  it("switches to days at forty-eight hours", () => {
    expect(age(ago(48 * HOUR))).toBe("há 2 dias");
    expect(age(ago(10 * DAY))).toBe("há 10 dias");
  });
  // NEVER CLAMPED: a silent ceiling ("há mais de 30 dias") reads as a recent message, which is the
  // whole defect this variable exists to remove.
  it("does not cap the number of days", () => {
    expect(age(ago(400 * DAY))).toBe("há 400 dias");
  });
  // A message dated in the FUTURE is two clocks disagreeing, not a negative age.
  it("reads a future instant as just now", () => {
    expect(age(new Date(now.getTime() + HOUR))).toBe("agora mesmo");
  });
  // The EN spelling is a SECOND WORDING, not an alias of one string: the value is a sentence, so an
  // operator writing an English prompt has to get an English one.
  it("answers the English name in English", () => {
    expect(age(ago(3 * DAY), "{{message_age}}")).toBe("3 days ago");
    expect(age(ago(MIN), "{{message_age}}")).toBe("1 minute ago");
    expect(age(ago(30 * SEC), "{{message_age}}")).toBe("just now");
  });
  // No instant ⇒ empty, on BOTH spellings. Falling back to "now" is the wrong reading, and leaving
  // the placeholder literal puts `{{...}}` in front of the customer.
  it("renders empty when the instant is unknown", () => {
    expect(age(null)).toBe("");
    expect(age(undefined as unknown as null, "{{message_age}}")).toBe("");
  });
});

// The DATE the customer wrote, which is a different question from how long ago. An agent told only
// "há 9 dias" still has to subtract to know which day "hoje" meant in the message, and measured on
// the Guichê Web e-mail agent it does not: asked to do that subtraction it answered with TODAY's
// date as the event's. The cases below fence the three things that made the phrase insufficient —
// the day is the customer's, the zone is the one the clock variables use, and no instant is empty.
describe("interpolatePromptVars message date", () => {
  const now = new Date("2026-09-21T12:00:00-03:00");
  const tz = "America/Sao_Paulo";
  const at = (messageAt: Date | null, tpl = "{{data_ultima_mensagem}}") =>
    interpolatePromptVars(tpl, {}, { now, messageAt, timezone: tz });

  // THE POINT OF THE VARIABLE: nine days old, and what comes back is the day the customer wrote,
  // never the day the prompt is being rendered. A renderer that answered `now` would pass every
  // other case here and reintroduce the exact defect.
  it("answers the day the customer wrote, not today", () => {
    expect(at(new Date("2026-09-12T14:46:00-03:00"))).toBe("12/09/2026 14:46");
    expect(at(new Date("2026-09-12T14:46:00-03:00"))).not.toContain("21/09");
  });

  // Same zone as {{hora_atual}} and friends: a prompt that dates the message in UTC next to a local
  // clock is reporting two zones, and the model reconciles that by inventing.
  it("renders in the prompt's timezone, not UTC", () => {
    // 01:30Z on the 13th is still the 12th, 22:30, in São Paulo.
    expect(at(new Date("2026-09-13T01:30:00Z"))).toBe("12/09/2026 22:30");
  });

  it("accepts a format like the clock variables", () => {
    expect(
      at(
        new Date("2026-09-12T14:46:00-03:00"),
        "{{data_ultima_mensagem:DD/MM}}",
      ),
    ).toBe("12/09");
  });

  // Empty, not "now" and not a literal `{{...}}`, for the callers with no triggering message
  // (compaction, the observer, the playground) — the same rule the age variable follows.
  it("renders empty when the instant is unknown", () => {
    expect(at(null)).toBe("");
    expect(at(undefined as unknown as null, "{{message_date}}")).toBe("");
  });

  it("answers the English spelling too", () => {
    expect(at(new Date("2026-09-12T14:46:00-03:00"), "{{message_date}}")).toBe(
      "12/09/2026 14:46",
    );
  });
});

// The editor underlines anything `isKnownPromptVar` does not recognise, so a variable the same
// editor offers in its insert helper and then paints as invalid is worse than one that does not
// exist: the operator reads the warning and removes a placeholder that works. Both spellings, for
// the same reason the renderer answers both.
describe("message-date variables are known to the editor", () => {
  it("recognises both spellings", () => {
    expect(isKnownPromptVar("data_ultima_mensagem")).toBe(true);
    expect(isKnownPromptVar("message_date")).toBe(true);
  });
  // The insert helper and the known set are two lists, and this is the assertion that keeps them
  // from drifting: every name the editor offers has to survive the editor's own check.
  it("knows every name the insert helper offers", () => {
    for (const v of PROMPT_MESSAGE_DATE_VARS_DISPLAY) {
      expect(isKnownPromptVar(v)).toBe(true);
    }
  });
});
