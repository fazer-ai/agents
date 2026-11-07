import { expect, test } from "bun:test";
import { formatters } from "@/client/pages/admin/database/format";

// A signal's value and threshold on the Database screen are written by the locale, in the signal's
// unit, like every other figure on the page.
test("a signal's figure follows the locale in each unit", () => {
  const pt = formatters("pt-BR");
  const en = formatters("en");
  expect(pt.signal(61.4, "percent")).toBe("61%");
  expect(pt.signal(1_234, "per_minute")).toBe("1.234/min");
  expect(en.signal(1_234, "per_minute")).toBe("1,234/min");
  expect(pt.signal(1_500, "ms")).toBe("1,5 s");
  expect(en.signal(1_500, "ms")).toBe("1.5 s");
  expect(pt.signal(4_060, "count")).toBe("4.060");
});
