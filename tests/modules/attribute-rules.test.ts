import { describe, expect, test } from "bun:test";
import {
  parseAttributePattern,
  testAttributePattern,
} from "@/modules/chatwoot/attribute-pattern";
import {
  type AttributeRuleDef,
  checkAttributeValue,
} from "@/modules/chatwoot/attribute-rules";

const def = (over: Partial<AttributeRuleDef>): AttributeRuleDef => ({
  key: "k",
  displayType: "text",
  values: [],
  regexPattern: null,
  regexCue: null,
  ...over,
});

describe("checkAttributeValue", () => {
  test("a blank value is refused with or without a definition", async () => {
    expect(await checkAttributeValue(undefined, "")).toEqual({
      ok: false,
      rule: "empty",
    });
    expect(await checkAttributeValue(def({}), "   ")).toEqual({
      ok: false,
      rule: "empty",
    });
  });

  test("a key without a definition takes any non-blank value, trimmed", async () => {
    expect(await checkAttributeValue(undefined, "  Oi  ")).toEqual({
      ok: true,
      value: "Oi",
    });
  });

  test("a list takes only one of its options, spelled exactly", async () => {
    const d = def({ displayType: "list", values: ["Infantil", "Fundamental"] });
    expect(await checkAttributeValue(d, "Fundamental")).toEqual({
      ok: true,
      value: "Fundamental",
    });
    expect(await checkAttributeValue(d, "fundamental")).toEqual({
      ok: false,
      rule: "list",
    });
    expect(await checkAttributeValue(d, "5º ano")).toEqual({
      ok: false,
      rule: "list",
    });
  });

  test("number, currency and percent take digits with an optional decimal point", async () => {
    for (const displayType of ["number", "currency", "percent"]) {
      const d = def({ displayType });
      expect(await checkAttributeValue(d, "1500")).toEqual({
        ok: true,
        value: "1500",
      });
      expect(await checkAttributeValue(d, "-12.5")).toEqual({
        ok: true,
        value: "-12.5",
      });
      expect(await checkAttributeValue(d, "mil e quinhentos")).toEqual({
        ok: false,
        rule: "number",
      });
      expect(await checkAttributeValue(d, "12,5")).toEqual({
        ok: false,
        rule: "number",
      });
    }
  });

  test("a date takes a real calendar date as YYYY-MM-DD, or the ISO timestamp Chatwoot stores", async () => {
    const d = def({ displayType: "date" });
    expect(await checkAttributeValue(d, "2026-10-20")).toEqual({
      ok: true,
      value: "2026-10-20",
    });
    expect(await checkAttributeValue(d, "2026-10-20T03:00:00.000Z")).toEqual({
      ok: true,
      value: "2026-10-20T03:00:00.000Z",
    });
    expect(await checkAttributeValue(d, "2026-02-30")).toEqual({
      ok: false,
      rule: "date",
    });
    expect(await checkAttributeValue(d, "20/10/2026")).toEqual({
      ok: false,
      rule: "date",
    });
    expect(await checkAttributeValue(d, "amanhã")).toEqual({
      ok: false,
      rule: "date",
    });
  });

  test("a checkbox takes true or false, written lowercase", async () => {
    const d = def({ displayType: "checkbox" });
    expect(await checkAttributeValue(d, "TRUE")).toEqual({
      ok: true,
      value: "true",
    });
    expect(await checkAttributeValue(d, "false")).toEqual({
      ok: true,
      value: "false",
    });
    expect(await checkAttributeValue(d, "sim")).toEqual({
      ok: false,
      rule: "checkbox",
    });
  });

  test("a link takes an http(s) URL and skips the pattern, as the dashboard does", async () => {
    const d = def({ displayType: "link", regexPattern: "/^never$/" });
    expect(await checkAttributeValue(d, "https://exemplo.com/a")).toEqual({
      ok: true,
      value: "https://exemplo.com/a",
    });
    expect(await checkAttributeValue(d, "exemplo.com")).toEqual({
      ok: false,
      rule: "link",
    });
    expect(await checkAttributeValue(d, "ftp://exemplo.com/a")).toEqual({
      ok: false,
      rule: "link",
    });
    for (const v of ["https:exemplo.com", "https:/exemplo.com"])
      expect(await checkAttributeValue(d, v)).toEqual({
        ok: false,
        rule: "link",
      });
    expect(await checkAttributeValue(d, "javascript:alert(1)")).toEqual({
      ok: false,
      rule: "link",
    });
  });

  test("the pattern holds a text value back, in the /source/flags form Chatwoot stores", async () => {
    const d = def({
      regexPattern: "/^(?!(oi|bom dia|tudo bem)$)[a-zà-ú ]{2,}$/i",
      regexCue: "Nome da pessoa",
    });
    expect(await checkAttributeValue(d, "Maria Souza")).toEqual({
      ok: true,
      value: "Maria Souza",
    });
    expect(await checkAttributeValue(d, "Oi")).toEqual({
      ok: false,
      rule: "pattern",
    });
    expect(await checkAttributeValue(d, "Bom dia")).toEqual({
      ok: false,
      rule: "pattern",
    });
  });

  test("a pattern that does not compile refuses, as the dashboard does", async () => {
    const d = def({ regexPattern: "/([a-z/" });
    expect(await checkAttributeValue(d, "qualquer")).toEqual({
      ok: false,
      rule: "pattern",
    });
  });
});

describe("the pattern check", () => {
  test("reads the bare source of an older row too", async () => {
    expect(await testAttributePattern("^\\d+$", "123")).toBe("match");
    expect(await testAttributePattern("^\\d+$", "12a")).toBe("no_match");
  });

  test("drops g and y, so the same value answers the same every time", () => {
    expect(parseAttributePattern("/^a$/gyi")).toEqual({
      source: "^a$",
      flags: "i",
    });
  });

  test("a backtracking pattern runs out of its budget off the event loop, and is refused", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    const verdict = await testAttributePattern(
      "/^(a+)+$/",
      `${"a".repeat(40)}!`,
      { timeoutMs: 100 },
    );
    clearInterval(timer);
    expect(verdict).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThan(5);
    const d = def({ regexPattern: "/^(a+)+$/" });
    expect(
      await checkAttributeValue(d, "aaaa!", async () => "timeout"),
    ).toEqual({ ok: false, rule: "pattern_timeout" });
  });

  test("a checkbox is held to its pattern after it is normalized", async () => {
    const d = def({ displayType: "checkbox", regexPattern: "/^true$/" });
    expect(await checkAttributeValue(d, "TRUE")).toEqual({
      ok: true,
      value: "true",
    });
    expect(await checkAttributeValue(d, "false")).toEqual({
      ok: false,
      rule: "pattern",
    });
  });

  test("a timestamp's time and offset are held to real ranges", async () => {
    const d = def({ displayType: "date" });
    for (const bad of [
      "2026-10-20T99:99:99Z",
      "2026-10-20T24:00:00Z",
      "2026-10-20T12:60Z",
      "2026-10-20T12:30:00+99:99",
      "2026-10-20T12:30:00+15:00",
      "2026-10-20T12:30:00+03:60",
    ])
      expect(await checkAttributeValue(d, bad)).toEqual({
        ok: false,
        rule: "date",
      });
    expect(await checkAttributeValue(d, "2026-10-20T23:59:59-03:00")).toEqual({
      ok: true,
      value: "2026-10-20T23:59:59-03:00",
    });
  });
});
