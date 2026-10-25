import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { getCatalogEntry } from "@/modules/integrations/catalog";

// `integration_catalog` is all a coding agent reads over MCP before deciding whether a service
// fits the panel. When the GENERIC entry described only the operator's own system, an agent asked
// about Mercado Pago in a clean tenant concluded the payment notice could not land and proposed a
// relay in the middle (#1654). The entry has to name the gateway path and the keys that build it.
describe("GENERIC catalog entry", () => {
  const description = getCatalogEntry("GENERIC")?.description ?? "";

  test("names a payment gateway that notifies with only an id", () => {
    expect(description).toContain("Mercado Pago");
    expect(description).toContain("only an id");
  });

  test("names the config keys that verify the signature and look the payment up", () => {
    for (const key of [
      "config.signatureHeader",
      "config.signature",
      "config.fetchBack",
      "conversationRefPath",
      "statusPath",
    ]) {
      expect(description).toContain(key);
    }
  });

  test("links the public page that documents the config shape", () => {
    expect(description).toMatch(/https:\/\/github\.com\/fazer-ai\/agents\/\S+/);
  });

  test("the console text tells an operator the same, in both locales", () => {
    for (const locale of [en, ptBR]) {
      const generic = locale.integrations.catalog.GENERIC;
      expect(generic.description).toContain("Mercado Pago");
      expect(generic.hint).toContain("Mercado Pago");
    }
  });
});
